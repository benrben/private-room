"""The parked-result store and its reader (`results.py`), on their own.

Everything here is a pure function of a store and a dict of arguments — the
same discipline the write-claim gate has, and for the same reason: the model
sends these arguments, so every shape a 4B can produce has to be answered
truthfully rather than crash a round.

The graph wiring — when a result is parked, who may read it, what happens to
the catalog — is `test_result_spill.py`.
"""

from __future__ import annotations

import re

import pytest

from arcelle_sidecar import results
from arcelle_sidecar.budget import byte_len
from arcelle_sidecar.results import (
    FIND_HITS,
    SLICE_BYTES,
    ResultStore,
    Spill,
    read_spill,
)

#: The "continue from here" position a window hands back.
_CONTINUE = re.compile(r"continue with offset=(\d+)")


def _lines(count: int) -> str:
    """A text whose every position is identifiable, and which contains no `[`
    — so a test can split a window's frame off its body without ambiguity."""
    return "\n".join(f"line {i:05d} " + "." * 40 for i in range(count))


def _body(window: str) -> str:
    """The content of a window, with the `[ref, from position …]` frame removed."""
    return window.split("\n", 1)[1].rsplit("\n[", 1)[0]


def _park(text: str, tool: str = "fetch_page") -> tuple[ResultStore, list[str], Spill]:
    store = ResultStore()
    spill = store.put(tool, text)
    return store, [spill.ref], spill


# --- the store ----------------------------------------------------------------


def test_refs_are_minted_in_order_and_never_reused() -> None:
    store = ResultStore()
    first = store.put("fetch_page", "a")
    second = store.put("browse_read", "b")
    assert [first.ref, second.ref] == ["res_1", "res_2"]
    assert store.get("res_1") is first
    assert store.get("res_2") is second
    assert store.get("res_3") is None


def test_size_counts_utf8_bytes_not_codepoints() -> None:
    """The unit every budget in this app counts in — a Hebrew page measured in
    codepoints is half its real cost."""
    spill = ResultStore().put("fetch_page", "שלום" * 100)
    assert len(spill.text) == 400
    assert spill.size == 800


def test_a_head_never_splits_a_character() -> None:
    """Every Hebrew character costs two bytes, so an odd limit lands mid-letter."""
    spill = ResultStore().put("fetch_page", "שלום" * 100)
    head = spill.head(101)
    assert head == spill.text[:50], "the last whole character within 101 bytes"
    assert byte_len(head) == 100


def test_the_cap_drops_the_oldest_spill_first(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(results, "STORE_CAP_BYTES", 100)
    store = ResultStore()
    old = store.put("fetch_page", "o" * 60)
    mid = store.put("fetch_page", "m" * 60)
    assert store.get(old.ref) is None, "the oldest spill should have been dropped"
    assert store.get(mid.ref) is mid
    assert len(store) == 1


def test_the_newest_spill_survives_even_alone_over_the_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A single oversized result parking and instantly vanishing is the exact
    failure this module exists to remove."""
    monkeypatch.setattr(results, "STORE_CAP_BYTES", 100)
    store = ResultStore()
    huge = store.put("fetch_page", "x" * 5_000)
    assert store.get(huge.ref) is huge
    assert len(store) == 1


# --- reading: the arguments a model actually sends -----------------------------


def test_an_unknown_ref_names_the_refs_that_do_exist() -> None:
    store, refs, _ = _park(_lines(50))
    text, ok = read_spill(store, refs, {"ref": "res_99"})
    assert not ok
    assert "res_99" in text and "res_1" in text


def test_reading_when_nothing_was_ever_parked_says_so() -> None:
    text, ok = read_spill(ResultStore(), [], {"ref": "res_1"})
    assert not ok
    assert "Nothing has been shortened" in text


def test_a_missing_ref_argument_is_an_error_not_a_crash() -> None:
    store, refs, _ = _park(_lines(50))
    for arguments in ({}, {"ref": None}, {"ref": ""}, {"ref": "   "}):
        text, ok = read_spill(store, refs, arguments)
        assert not ok, arguments
        assert "res_1" in text


def test_a_ref_this_loop_may_read_but_the_store_dropped_says_so(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`spills` lives in graph state and the store lives on `Deps`; the cap can
    evict one without the other noticing."""
    monkeypatch.setattr(results, "STORE_CAP_BYTES", 100)
    store = ResultStore()
    old = store.put("fetch_page", "o" * 60)
    store.put("fetch_page", "m" * 60)
    text, ok = read_spill(store, [old.ref, "res_2"], {"ref": old.ref})
    assert not ok
    assert "no longer held" in text


def test_a_sibling_ref_is_refused_even_though_the_store_holds_it() -> None:
    """The store is shared by the whole delegation tree; `refs` is the scope."""
    store = ResultStore()
    mine = store.put("fetch_page", _lines(50))
    theirs = store.put("browse_read", _lines(50))
    text, ok = read_spill(store, [mine.ref], {"ref": theirs.ref})
    assert not ok
    assert theirs.ref in text


@pytest.mark.parametrize("raw", ["10", " 10 ", 10, 10.0, "10.0"])
def test_offset_accepts_every_shape_a_small_model_sends(raw: object) -> None:
    store, refs, _ = _park(_lines(50))
    text, ok = read_spill(store, refs, {"ref": "res_1", "offset": raw})
    assert ok
    assert "from position 10 " in text


@pytest.mark.parametrize("raw", ["abc", "", None])
def test_an_unparseable_offset_reads_from_the_start_or_says_why(raw: object) -> None:
    """Empty and absent mean "from the beginning"; nonsense is told, not guessed."""
    store, refs, _ = _park(_lines(50))
    text, ok = read_spill(store, refs, {"ref": "res_1", "offset": raw})
    if raw == "abc":
        assert not ok and "offset must be" in text
    else:
        assert ok and "from position 0 " in text


@pytest.mark.parametrize("raw", [-1, 10**9, float("inf"), float("nan"), True])
def test_an_offset_outside_the_text_is_refused_not_clamped(raw: object) -> None:
    store, refs, spill = _park(_lines(50))
    text, ok = read_spill(store, refs, {"ref": "res_1", "offset": raw})
    assert not ok, raw
    assert "offset must be" in text
    assert str(len(spill.text)) in text, "the model is told the valid range"


# --- reading: windows ---------------------------------------------------------


def test_the_first_window_starts_at_the_beginning_and_says_what_is_left() -> None:
    store, refs, spill = _park(_lines(400))
    text, ok = read_spill(store, refs, {"ref": "res_1"})
    assert ok
    assert _body(text) == spill.text[: len(_body(text))]
    assert text.startswith(f"[res_1, from position 0 of {len(spill.text)}]")
    assert _CONTINUE.search(text)


def test_a_window_never_exceeds_one_slice() -> None:
    store, refs, _ = _park(_lines(4000))
    text, _ = read_spill(store, refs, {"ref": "res_1"})
    assert byte_len(_body(text)) <= SLICE_BYTES


def test_paging_reassembles_the_original_text_exactly() -> None:
    """The whole point: nothing is lost, and nothing is read twice."""
    store, refs, spill = _park(_lines(600))
    seen, offset, guard = "", 0, 0
    while True:
        guard += 1
        assert guard < 100, "paging did not terminate"
        text, ok = read_spill(store, refs, {"ref": "res_1", "offset": offset})
        assert ok
        seen += _body(text)
        step = _CONTINUE.search(text)
        if not step:
            assert "that was the end" in text
            break
        assert int(step.group(1)) > offset, "a page that does not advance loops forever"
        offset = int(step.group(1))
    assert seen == spill.text


def test_paging_a_multibyte_text_neither_drops_nor_duplicates_a_character() -> None:
    store, refs, spill = _park("שלום עולם " * 2000)
    first, _ = read_spill(store, refs, {"ref": "res_1"})
    step = _CONTINUE.search(first)
    assert step
    at = int(step.group(1))
    assert _body(first) == spill.text[:at]
    second, _ = read_spill(store, refs, {"ref": "res_1", "offset": at})
    assert _body(second) == spill.text[at : at + len(_body(second))]


def test_reading_from_the_very_end_says_so_rather_than_returning_nothing() -> None:
    store, refs, spill = _park(_lines(50))
    text, ok = read_spill(store, refs, {"ref": "res_1", "offset": len(spill.text)})
    assert ok
    assert "there is nothing after" in text


def test_a_text_shorter_than_one_slice_is_returned_whole_and_marked_ended() -> None:
    store, refs, spill = _park("just a little text")
    text, ok = read_spill(store, refs, {"ref": "res_1"})
    assert ok
    assert _body(text) == spill.text
    assert "that was the end" in text


# --- reading: find ------------------------------------------------------------


def test_find_returns_windows_around_each_match_with_its_position() -> None:
    store, refs, spill = _park(_lines(400))
    text, ok = read_spill(store, refs, {"ref": "res_1", "find": "line 00123"})
    assert ok
    assert "line 00123" in text
    at = spill.text.index("line 00123")
    assert f"around position {at}" in text


def test_find_is_case_insensitive() -> None:
    store, refs, _ = _park("The Effective Rate is 4.25%")
    text, ok = read_spill(store, refs, {"ref": "res_1", "find": "EFFECTIVE rate"})
    assert ok
    assert "Effective Rate" in text


def test_find_caps_the_number_of_matches() -> None:
    store, refs, _ = _park("needle " * 50)
    text, ok = read_spill(store, refs, {"ref": "res_1", "find": "needle"})
    assert ok
    assert text.count("around position ") == FIND_HITS
    assert f"{FIND_HITS} match(es)" in text


def test_find_answers_never_exceed_one_slice() -> None:
    store, refs, _ = _park(("needle" + "." * 5_000) * 20)
    text, _ = read_spill(store, refs, {"ref": "res_1", "find": "needle"})
    assert byte_len(text) <= SLICE_BYTES + 200, "frame aside, one slice is the cap"


def test_find_starts_from_the_offset_it_was_given() -> None:
    store, refs, spill = _park("alpha " + "." * 200 + " alpha")
    late = spill.text.rindex("alpha")
    text, ok = read_spill(store, refs, {"ref": "res_1", "find": "alpha", "offset": 10})
    assert ok
    assert f"around position {late}" in text
    assert "around position 0" not in text


def test_a_search_that_finds_nothing_is_a_truthful_answer_not_an_error() -> None:
    """`ok=False` would let the model retry the identical call forever — the
    duplicate memo only records successes."""
    store, refs, _ = _park(_lines(50))
    text, ok = read_spill(store, refs, {"ref": "res_1", "find": "unicorn"})
    assert ok
    assert "does not appear" in text


def test_an_empty_find_reads_a_window_instead_of_searching_for_nothing() -> None:
    store, refs, spill = _park(_lines(50))
    text, ok = read_spill(store, refs, {"ref": "res_1", "find": "  "})
    assert ok
    assert _body(text) == spill.text
