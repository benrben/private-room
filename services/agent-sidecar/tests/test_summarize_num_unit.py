"""Pure numeric argument parsing coverage for summarize's read tool."""

from __future__ import annotations

import math

import pytest

from arcelle_sidecar import summarize


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0, 0),
        (17, 17),
        (-17, 0),
        (3.9, 3),
        (-3.9, 0),
        ("  42  ", 42),
        ("-8", -8),
    ],
)
def test_num_parses_supported_values_with_its_type_specific_boundaries(
    value: object, expected: int
) -> None:
    assert summarize._num(value) == expected


@pytest.mark.parametrize(
    "value", [True, False, None, "", "2.5", "twelve", [], {"offset": 4}]
)
def test_num_returns_none_for_unsupported_or_malformed_values(value: object) -> None:
    assert summarize._num(value) is None


def test_read_args_uses_defaults_when_num_cannot_parse_a_model_argument() -> None:
    assert summarize.read_args(
        {"offset": True, "limit": "2.5", "find": "  clause  "}
    ) == (0, summarize.READ_WINDOW_DEFAULT, "clause")


def test_num_clamps_nan_by_its_float_floor_rule() -> None:
    assert summarize._num(math.nan) == 0


def test_num_exposes_the_infinite_float_conversion_error() -> None:
    with pytest.raises(OverflowError):
        summarize._num(math.inf)
