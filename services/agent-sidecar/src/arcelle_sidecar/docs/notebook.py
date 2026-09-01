"""Jupyter notebook (.ipynb) text extraction: prose, code and printed output,
in cell order.

Port of the notebook section of `src-tauri/src/extraction/data.rs`
(`extract_ipynb`, `joined_source`, `output_text`), plus a local copy of the
`push_capped`/`MAX_DERIVED_CHARS` bound from lines 1-35 of that file.

The raw `.ipynb` is JSON, so before this the file either imported with no text
at all or (had it been treated as a text extension) contributed its own
escaped source to the index -- `"cell_type": "markdown"` and `\\n`-riddled
string arrays instead of the sentences a reader wrote.
"""

from __future__ import annotations

import json
from typing import Any

# Bound on how much text this reader contributes to the index -- same value
# and purpose as `extraction/data.rs`'s module-wide `MAX_DERIVED_CHARS`. This
# module owns its own copy rather than importing one from elsewhere, matching
# this codebase's established pattern for a bound that isn't genuinely shared
# yet (see `arcelle_sidecar.docs.mail`'s identical local copy).
_MAX_DERIVED_CHARS = 8 * 1024 * 1024


def _push_capped(out: list[str], s: str, total_len: list[int]) -> None:
    """Append `s` to `out`, capping the running UTF-8 byte total at
    `_MAX_DERIVED_CHARS`. An addition that would cross the cap is trimmed at
    the last whole UTF-8 character rather than included partially or raising
    -- mirrors the Rust source's `is_char_boundary` walk-back, done here over
    UTF-8 bytes since Python strings are indexed by code point, not byte.

    `out` and `total_len` are one-element-list "out params" so this stays a
    small local helper (this module owns its own copy) without needing a
    class.
    """
    room = _MAX_DERIVED_CHARS - total_len[0]
    if room <= 0:
        return
    encoded = s.encode("utf-8")
    if len(encoded) <= room:
        out.append(s)
        total_len[0] += len(encoded)
        return
    cut = room
    # Walk back to the start of a UTF-8 sequence: continuation bytes have the
    # top two bits `10`.
    while cut > 0 and (encoded[cut] & 0xC0) == 0x80:
        cut -= 1
    trimmed = encoded[:cut].decode("utf-8")
    out.append(trimmed)
    total_len[0] += len(trimmed.encode("utf-8"))


def extract_ipynb(data: bytes) -> str | None:
    """Prose, code and printed output from a Jupyter notebook, in cell
    order."""
    cells = _notebook_cells(data)
    if cells is None:
        return None
    out: list[str] = []
    total_len = [0]
    for index, cell in enumerate(cells):
        _append_cell(out, total_len, index, cell)
    result = "".join(out)
    return result if result.strip() else None


def _notebook_cells(data: bytes) -> list[Any] | None:
    """Return the cell array from a strictly UTF-8 notebook payload."""
    try:
        # Decode as strict UTF-8 first rather than handing raw bytes to
        # `json.loads`: the latter auto-detects UTF-16/UTF-32 by BOM/null-byte
        # pattern and silently strips a UTF-8 BOM (`utf-8-sig`), both more
        # lenient than `serde_json::from_slice`, which only ever reads UTF-8
        # and has no BOM handling of its own (the sibling `.eml` reader has to
        # strip a BOM by hand for exactly this reason). A notebook that isn't
        # valid, BOM-less UTF-8 should read as "not a notebook" here too.
        text = data.decode("utf-8")
        nb = json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(nb, dict):
        return None
    cells = nb.get("cells")
    return cells if isinstance(cells, list) else None


def _append_cell(out: list[str], total_len: list[int], index: int, value: Any) -> None:
    """Append one notebook cell's source and outputs in document order."""
    cell = value if isinstance(value, dict) else {}
    kind = cell.get("cell_type")
    source = _joined_source(cell.get("source"))
    if source.strip():
        _append_cell_source(out, total_len, index, kind, source)
    _append_cell_outputs(out, total_len, cell.get("outputs"))


def _append_cell_source(
    out: list[str], total_len: list[int], index: int, kind: Any, source: str
) -> None:
    """Append source, adding labels only for non-prose cells."""
    if kind in ("markdown", "raw"):
        _push_capped(out, source, total_len)
    else:
        _push_capped(out, f"[cell {index + 1}]\n", total_len)
        _push_capped(out, source, total_len)
    _push_capped(out, "\n\n", total_len)


def _append_cell_outputs(out: list[str], total_len: list[int], outputs: Any) -> None:
    """Append readable cell outputs, skipping malformed and binary values."""
    if not isinstance(outputs, list):
        return
    for output in outputs:
        if not isinstance(output, dict):
            continue
        text = _output_text(output)
        if text.strip():
            _push_capped(out, text, total_len)
            _push_capped(out, "\n", total_len)


def _joined_source(v: Any) -> str:
    """`source` and `text` are either a string or an array of line-strings
    (nbformat allows both, and real notebooks contain both)."""
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return "".join(line for line in v if isinstance(line, str))
    return ""


def _output_text(output: dict[str, Any]) -> str:
    """The readable part of one cell output: stream text, or the
    `text/plain` representation of a rich display value. Images and widget
    JSON are skipped."""
    if "text" in output:
        return _joined_source(output.get("text"))
    data = output.get("data")
    if isinstance(data, dict) and "text/plain" in data:
        return _joined_source(data.get("text/plain"))
    return ""
