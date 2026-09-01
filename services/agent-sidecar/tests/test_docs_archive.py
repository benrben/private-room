"""Tests for `arcelle_sidecar.docs.archive` (port of the archive section of
`src-tauri/src/extraction/data.rs`).

Ports `a_zip_lists_the_names_inside_it` verbatim, plus the zip-related
assertion from `unreadable_bytes_read_as_nothing_rather_than_panicking`
(non-zip bytes return `None`) -- both `#[cfg(test)]` cases in the Rust
source.
"""

from __future__ import annotations

import io
import struct
import zipfile

from arcelle_sidecar.docs.archive import extract_zip_listing


def _build_zip(names: list[str]) -> bytes:
    """An in-memory zip with one (empty-content) entry per name, in
    insertion order -- the Python-side equivalent of the Rust test's
    `zip::ZipWriter` loop."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name in names:
            zf.writestr(name, b"ignored")
    return buf.getvalue()


def test_a_zip_lists_the_names_inside_it() -> None:
    zipped = _build_zip(["reports/q1.txt", "reports/q2.txt"])
    text = extract_zip_listing(zipped)
    assert text is not None
    assert "reports/q1.txt" in text
    assert "reports/q2.txt" in text


def test_a_zip_listing_skips_directory_entries() -> None:
    text = extract_zip_listing(_build_zip(["reports/", "reports/q1.txt"]))
    assert text == "reports/q1.txt\t7\n"


def test_unreadable_bytes_read_as_nothing_rather_than_panicking() -> None:
    assert extract_zip_listing(b"not a zip") is None


def test_declared_extract_version_beyond_support_reads_as_none() -> None:
    """Adversarial case: a zip whose central directory record declares a
    "version needed to extract" past what `zipfile` implements. Parsing the
    table of contents alone (no entry ever opened) raises a bare
    `NotImplementedError` from inside the stdlib -- this must still surface
    as `None`, the same as any other unreadable zip, not as an uncaught
    exception escaping the port's boundary.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("a.txt", b"hello")
    data = bytearray(buf.getvalue())

    idx = data.find(b"PK\x01\x02")
    assert idx != -1, "central directory record signature not found"
    data[idx + 6 : idx + 8] = struct.pack("<H", 999)  # version 99.9

    assert extract_zip_listing(bytes(data)) is None
