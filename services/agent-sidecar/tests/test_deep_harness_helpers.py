from __future__ import annotations

import pytest

from arcelle_sidecar.deep_harness import _safe_virtual_path, _text


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("plain text", "plain text"),
        (
            [
                {"type": "text", "text": "first"},
                {"type": "image"},
                {"type": "text", "text": 4},
                "ignored",
                {"type": "text"},
            ],
            "first\n4\n",
        ),
        (None, ""),
        (0, ""),
    ],
)
def test_text_preserves_supported_content_shapes(content: object, expected: str) -> None:
    assert _text(content) == expected


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        (r"notes\ideas.md", "/notes/ideas.md"),
        ("/./notes//ideas.md", "/notes/ideas.md"),
        ("/", "/"),
    ],
)
def test_safe_virtual_path_normalizes_workspace_paths(path: str, expected: str) -> None:
    assert _safe_virtual_path(path) == expected


@pytest.mark.parametrize("path", ["../outside", "/notes/../outside", "/.ArCeLlE/room.db"])
def test_safe_virtual_path_rejects_private_and_traversal_paths(path: str) -> None:
    with pytest.raises(ValueError):
        _safe_virtual_path(path)
