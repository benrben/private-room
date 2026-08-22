"""iWork (.pages/.key/.numbers) preview extraction.

Port of `src-tauri/src/extraction.rs` (`iwork_preview_entry`, `extract_iwork`),
lines 474-511.

------------------------------------------------------------------ overview

Modern iWork documents are a zip whose document body is IWA -- Snappy-framed
protobuf with an undocumented schema -- so there is no cheap honest way to
read the text itself. But "Include preview in document" (on by default for
anything shared or saved from iCloud) writes a full PDF rendering of the
document into the same zip, and that is ordinary text via
`arcelle_sidecar.docs.pdf.extract_pdf`.

The preview entry is matched by SUFFIX rather than by an exact path: it sits
at `QuickLook/Preview.pdf` in a flat bundle and at
`<name>/QuickLook/Preview.pdf` in a package bundle, and the two spellings are
the same file. `to_ascii_lowercase()` in the Rust source folds only ASCII
`A`-`Z` (not Python's Unicode-aware `str.lower()`, which can change a
string's length for characters like Turkish `Ä°`) -- `_ascii_lower` below
mirrors that exactly, matching the same choice already made in the sibling
`arcelle_sidecar.docs.epub` module for the same reason.

--------------------------------------------------------------------- budget

The entry is read under the same decompression-bomb ceiling every other zip
part in this codebase gets (`MAX_ZIP_ENTRY_BYTES`, imported from
`xml_utils`), checked TWICE: once against the zip's own declared
(uncompressed) size, and again against the actual number of bytes a bounded
read returns. The Rust source does both checks even though `zip_entry_names`
already ran once over the same archive -- a crafted central-directory record
can declare a small size and still decompress to something larger, so the
declared value is never trusted alone. `zipfile`'s own `ZipExtFile.read`
happens to truncate its output to the declared `file_size` for every
archive it can produce itself, which makes the second check unreachable
through an honestly-built zip -- but it is kept anyway, unconditionally,
matching the Rust source's structure and the same "declared size can lie"
reasoning `arcelle_sidecar.docs.xml_utils.read_zip_entry_capped` documents
for exactly the same pattern. A test in this module's suite exercises it
directly (by faking a lying reader) rather than skipping it as dead code.
"""

from __future__ import annotations

import io
import zipfile

from arcelle_sidecar.docs.pdf import extract_pdf
from arcelle_sidecar.docs.xml_utils import (
    MAX_ZIP_ENTRY_BYTES,
    _ZIP_READ_ERRORS,
    zip_entry_names,
)


def _ascii_lower(s: str) -> str:
    """`str::to_ascii_lowercase` -- fold only 'A'-'Z', leave every other
    character untouched. See module docstring.
    """
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def iwork_preview_entry(names: list[str]) -> str | None:
    """The first entry (in listed/archive order) whose lowercased name ends
    in `quicklook/preview.pdf` -- matches both a flat bundle's
    `QuickLook/Preview.pdf` and a package bundle's
    `<name>/QuickLook/Preview.pdf`. `None` if no entry qualifies.
    """
    for name in names:
        if _ascii_lower(name).endswith("quicklook/preview.pdf"):
            return name
    return None


def extract_iwork(data: bytes) -> str | None:
    """Text of an iWork bundle, via its PDF preview. `None` when the bundle
    carries no preview -- there is nothing to read, and saying so is the
    whole point -- or when the preview entry can't be read at all (not a
    zip, entry missing, encrypted/unsupported compression, over the
    decompression-bomb ceiling either by declared or by actual size), or
    when `extract_pdf` itself returns `None` for the recovered bytes.
    """
    names = zip_entry_names(data)
    entry = iwork_preview_entry(names)
    if entry is None:
        return None

    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except _ZIP_READ_ERRORS:
        return None
    try:
        info = archive.getinfo(entry)
    except KeyError:
        return None
    # Declared size can lie, so the bounded read below is the real guard;
    # checking the header first just skips the work for an honest oversized
    # entry.
    if info.file_size > MAX_ZIP_ENTRY_BYTES:
        return None
    try:
        with archive.open(info) as fh:
            pdf = fh.read(MAX_ZIP_ENTRY_BYTES + 1)
    except _ZIP_READ_ERRORS:
        return None
    if len(pdf) > MAX_ZIP_ENTRY_BYTES:
        return None
    return extract_pdf(pdf)


__all__ = ["iwork_preview_entry", "extract_iwork"]
