"""String-only branch coverage for the lightweight OOXML attribute reader."""

from __future__ import annotations

import pytest

from arcelle_sidecar.docs import xml_utils


@pytest.mark.parametrize(
    ("tag", "name", "expected"),
    [
        ('<w:relationship Target="slides/slide1.xml">', "Target", "slides/slide1.xml"),
        ("<item href='a&amp;b&#x2F;c'>", "href", "a&b/c"),
        ('<node state="">', "state", ""),
        ('<node id="still-available"', "id", "still-available"),
    ],
)
def test_xml_attr_reads_quoted_values_and_decodes_entities(
    tag: str, name: str, expected: str
) -> None:
    assert xml_utils.xml_attr(tag, name) == expected


@pytest.mark.parametrize(
    ("tag", "name"),
    [
        ('<node id="7">', "missing"),
        ("<node>", "id"),
        ("<node id=", "id"),
        ("<node id=7>", "id"),
        ('<node id="unterminated>', "id"),
        ('<node title="a > b" id="late">', "id"),
        ('<node> id="late"', "id"),
    ],
)
def test_xml_attr_returns_none_for_missing_or_malformed_values(tag: str, name: str) -> None:
    assert xml_utils.xml_attr(tag, name) is None
