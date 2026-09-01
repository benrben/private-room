"""Tests for `arcelle_sidecar.docs.notebook` (port of the notebook section of
`src-tauri/src/extraction/data.rs`: `extract_ipynb` and its helpers).

Mirrors the Rust `#[cfg(test)]` notebook cases verbatim:
`a_notebook_gives_up_its_prose_code_and_output`,
`a_notebook_that_is_not_a_notebook_reads_as_nothing`.
"""

from __future__ import annotations

import json

from arcelle_sidecar.docs import notebook
from arcelle_sidecar.docs.notebook import extract_ipynb


def test_a_notebook_gives_up_its_prose_code_and_output() -> None:
    nb = {
        "cells": [
            {"cell_type": "markdown", "source": ["# Findings\n", "The rate is 4.2%.\n"]},
            {
                "cell_type": "code",
                "source": "print(total)",
                "outputs": [{"output_type": "stream", "text": ["4.2\n"]}],
            },
            {
                "cell_type": "code",
                "source": "df",
                "outputs": [
                    {
                        "output_type": "execute_result",
                        "data": {
                            "text/plain": "   a  b\n0  1  2",
                            "image/png": "iVBORw0KGgo=",
                        },
                    }
                ],
            },
        ]
    }
    text = extract_ipynb(json.dumps(nb).encode())
    assert text is not None, "no text"
    assert "The rate is 4.2%" in text, f"markdown prose missing: {text}"
    assert "print(total)" in text, f"code missing: {text}"
    assert "4.2" in text, f"stream output missing: {text}"
    assert "0  1  2" in text, f"text/plain result missing: {text}"
    # The base64 PNG must NOT reach the index.
    assert "iVBORw0KGgo" not in text, f"an image blob leaked into the text: {text}"


def test_a_notebook_that_is_not_a_notebook_reads_as_nothing() -> None:
    assert extract_ipynb(b"not json") is None
    assert extract_ipynb(b'{"nope": 1}') is None
    assert extract_ipynb(b'{"cells": []}') is None


def test_non_utf8_encoded_json_reads_as_nothing() -> None:
    # `serde_json::from_slice` only ever reads UTF-8 and has no BOM handling
    # of its own, unlike Python's `json.loads(bytes)`, which auto-detects
    # UTF-16/UTF-32 by BOM/null-byte pattern and silently strips a UTF-8 BOM.
    # A notebook byte string that is syntactically valid JSON only once
    # reinterpreted that way must still read as "not a notebook".
    nb = {"cells": [{"cell_type": "markdown", "source": "hello"}]}
    assert extract_ipynb(json.dumps(nb).encode("utf-16")) is None
    assert extract_ipynb(b"\xef\xbb\xbf" + json.dumps(nb).encode("utf-8")) is None


def test_notebook_skips_malformed_cells_and_unreadable_output() -> None:
    nb = {
        "cells": [
            None,
            {"cell_type": 3, "source": "unknown cell type"},
            {"cell_type": "markdown", "source": 3, "outputs": 3},
            {"cell_type": "raw", "source": [3, "raw cell"]},
            {
                "cell_type": "code",
                "source": "",
                "outputs": [None, {"data": {"image/png": "blob"}}, {"data": "not data"}],
            },
        ]
    }

    assert extract_ipynb(json.dumps(nb).encode()) == "[cell 2]\nunknown cell type\n\nraw cell\n\n"


def test_notebook_requires_a_cell_array() -> None:
    assert extract_ipynb(b"[]") is None
    assert extract_ipynb(b'{"cells": {}}') is None


def test_notebook_cap_preserves_whole_utf8_characters(monkeypatch) -> None:
    monkeypatch.setattr(notebook, "_MAX_DERIVED_CHARS", 5)
    nb = {
        "cells": [
            {"cell_type": "markdown", "source": "\u00e9\u00e9\u00e9"},
            {"cell_type": "markdown", "source": "ignored after the cap"},
        ]
    }

    assert extract_ipynb(json.dumps(nb).encode()) == "\u00e9\u00e9\n"
