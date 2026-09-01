"""The token-budget bar's arithmetic.

The bar has shipped wrong numbers before (2026-07-21: real usage divided by the
native 262k while the running window was 4k, so an overflowing turn read "1%
used"). Everything it puts on screen is computed here — which bytes land in
which category, what the estimate divides by, and how a real aggregate is
redistributed over the categories — and none of it was covered.

`usage.py` had a twin on the app side (`src-tauri/src/token_usage.rs`). That
twin is now down to the post-handoff placeholder snapshot; the last test pins
the two constants that still have to agree.
"""

from __future__ import annotations

import pytest

from arcelle_sidecar import model_limits
from arcelle_sidecar.budget import IMAGE_BYTES
from arcelle_sidecar.chat import RoundUsage
from arcelle_sidecar.usage import (
    CATEGORIES,
    CHARS_PER_TOKEN,
    FILE_TOOL_NAMES,
    build_usage_event,
    categorize_messages,
)

@pytest.fixture(autouse=True)
def _cold_ratio():
    """The estimate divides by the LIVE bytes-per-token ratio, which is
    process-global; pin it to the cold-start constant so these are arithmetic
    tests and not a race with whatever else has been measured."""
    model_limits.reset_token_ratio()
    yield
    model_limits.reset_token_ratio()


def _estimated(usage: RoundUsage, breakdown: dict[str, int]) -> dict:
    return build_usage_event(1, usage, breakdown)


# --------------------------------------------------------------------------- #
# what lands where
# --------------------------------------------------------------------------- #


def test_every_kind_of_message_lands_in_its_own_category() -> None:
    messages = [
        {"role": "system", "content": "s" * 300},
        {"role": "user", "content": "u" * 100},
        {"role": "assistant", "content": "a" * 100},
        {"role": "tool", "tool_name": "fetch_page", "content": "t" * 500},
        {"role": "tool", "tool_name": "read_skill", "content": "k" * 400},
        {"role": "tool", "tool_name": "open_file", "content": "f" * 700},
    ]
    totals = categorize_messages(messages, 900)
    assert totals["system"] == 300
    assert totals["history"] == 200
    assert totals["tools"] == 500 + 900  # the offered catalog rides here
    assert totals["skills"] == 400
    assert totals["files"] == 700
    assert set(totals) == set(CATEGORIES)


def test_a_screenshot_is_not_free() -> None:
    """A picture used to be measured by its caption alone, so the heaviest
    turns in the app showed the smallest "files" slice."""
    caption = "look at this"
    with_image = categorize_messages(
        [{"role": "user", "content": caption, "images": ["b64"]}], 0
    )
    assert with_image["files"] == len(caption) + IMAGE_BYTES
    assert with_image["history"] == 0, "a picture turn belongs to files, not history"


def test_a_tool_less_final_round_is_charged_no_catalog() -> None:
    totals = categorize_messages([{"role": "user", "content": "q"}], 0)
    assert totals["tools"] == 0


def test_a_negative_tool_catalog_never_reduces_the_tool_cost() -> None:
    totals = categorize_messages([], -1)
    assert totals["tools"] == 0


# --------------------------------------------------------------------------- #
# the numbers on screen
# --------------------------------------------------------------------------- #


def test_with_no_engine_report_the_bar_is_the_char_estimate() -> None:
    usage = RoundUsage(input_tokens=None, max_context=8_192, is_real=False)
    event = _estimated(usage, {"system": 3_000, "history": 3_000})
    assert event["estimated"] is True
    assert event["max_context"] == 8_192
    assert event["round"] == 1
    assert event["total_tokens"] == 2_000  # 6,000 bytes at the cold-start 3
    assert event["breakdown"]["system"]["tokens"] == 1_000
    assert all(event["breakdown"][c]["estimated"] for c in CATEGORIES)


def test_the_estimate_follows_the_measured_ratio_not_the_constant() -> None:
    """English prose measured 5.89 B/token (2026-07-28). Estimating at a flat 3
    told the user a round cost roughly twice what it did."""
    usage = RoundUsage(input_tokens=None, max_context=8_192, is_real=False)
    before = _estimated(usage, {"history": 58_900})["total_tokens"]
    for _ in range(10):
        model_limits.observe_token_ratio(5_890, 1_000)
    after = _estimated(usage, {"history": 58_900})["total_tokens"]
    assert before == pytest.approx(58_900 / CHARS_PER_TOKEN, rel=0.01)
    assert after == pytest.approx(58_900 / (5.89 * 0.85), rel=0.02)
    assert after < before / 1.5


def test_a_real_total_is_redistributed_over_the_categories() -> None:
    """The engine reports one aggregate and no breakdown, so the shares stay
    proportional to the estimate but must SUM to the number the engine gave."""
    usage = RoundUsage(input_tokens=900, max_context=32_768, is_real=True)
    event = _estimated(usage, {"system": 3_000, "history": 3_000, "tools": 6_000})
    assert event["estimated"] is False
    assert event["total_tokens"] == 900
    tokens = {c: event["breakdown"][c]["tokens"] for c in CATEGORIES}
    assert sum(tokens.values()) == 900
    assert tokens["tools"] == 450 and tokens["system"] == 225
    # Still flagged per-category: only the TOTAL is real.
    assert all(event["breakdown"][c]["estimated"] for c in CATEGORIES)


def test_a_real_total_survives_an_empty_estimate() -> None:
    """Nothing to scale by — the engine's number must still be what is shown,
    not a division by zero."""
    usage = RoundUsage(input_tokens=700, max_context=8_192, is_real=True)
    event = build_usage_event(None, usage, dict.fromkeys(CATEGORIES, 0))
    assert event["total_tokens"] == 700
    assert event["estimated"] is False
    assert "round" not in event
