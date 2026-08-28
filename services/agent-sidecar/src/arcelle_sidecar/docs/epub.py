"""EPUB text extraction: read every XHTML/HTML chapter in the book's own
reading order.

Port of `src-tauri/src/extraction.rs` (`extract_epub`, `epub_spine_order`),
lines 439-534. `iwork_preview_entry`/`extract_iwork` from the same source
range belong to a different module (`docs/iwork.py`) and are intentionally
not ported here. `xml_attr` is already ported in the sibling
`arcelle_sidecar.docs.xml_utils` module (signature: `xml_attr(tag: str,
name: str) -> str | None`) -- only its signature was consulted, not its
body, per instructions.

------------------------------------------------------------------ overview

An e-book is a zip of XHTML documents, so `strip_html` (already ported in
`arcelle_sidecar.docs.html`) does the actual text extraction per chapter.
Chapters are taken in the book's own reading order (the OPF spine) when
that can be read, and in name order otherwise -- which is what the
conventional `chapter001.xhtml` naming produces anyway.

`_epub_spine_order` resolves that reading order from the package document
(the `.opf` file): a manifest of `id` -> `href` pairs, and a spine listing
`idref`s in reading order. Both are read with a crude split-on-tag-open
scan (`"<item "` / `"<itemref"`) rather than a real XML parser, exactly as
the Rust source does.

----------------------------------------------------------------- ASCII fold

Entry-name matching (`.xhtml`/`.html`/`.htm`/`.opf` suffixes, the
`META-INF/` prefix) is done against an ASCII-only lowercased copy of each
name, matching the Rust source's `to_ascii_lowercase()` exactly -- NOT
Python's `str.lower()`, which is Unicode-aware and can change a string's
length (e.g. Turkish `İ`). Zip entry names are for all practical purposes
ASCII, but the fold is kept ASCII-only anyway, for the same reason
`arcelle_sidecar.docs.html` and `arcelle_sidecar.docs.xml_utils` do.

------------------------------------------------------------------- ordering

`extract_epub` sorts the filtered chapter-entry list alphabetically first
(this is also the fallback order when there is no OPF, or no spine could be
read), then re-sorts it by each entry's position in the spine -- using
Python's stable `list.sort()`, exactly mirroring the Rust source's
`docs.sort_by_key(|n| spine.iter().position(...).unwrap_or(usize::MAX))`
called on an already-alphabetically-sorted vector. An entry missing from
the spine sorts to the end (as if its key were `+inf`), but keeps its
relative alphabetical position among other missing entries because the
sort is stable.

--------------------------------------------------------------------- budget

The output budget (`MAX_ZIP_ENTRY_BYTES`, imported from `xml_utils`) is
spent in UTF-8 BYTES, matching Rust's `String::len()`: the running byte
length is tracked alongside the accumulated output and the loop stops the
moment the remaining budget reaches zero -- never negative, mirroring
`u64::saturating_sub`.
"""

from __future__ import annotations

from arcelle_sidecar.docs.html import strip_html
from arcelle_sidecar.docs.xml_utils import (
    MAX_ZIP_ENTRY_BYTES,
    read_zip_entry,
    read_zip_entry_capped,
    xml_attr,
    zip_entry_names,
)


def _ascii_lower(s: str) -> str:
    """`str::to_ascii_lowercase` -- fold only 'A'-'Z', leave every other
    character untouched. See module docstring.
    """
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


def extract_epub(data: bytes) -> str | None:
    """Concatenated, tag-stripped text of every XHTML/HTML chapter in an
    EPUB, in the book's own reading order when an OPF spine is readable,
    else alphabetical order. `None` if the archive isn't a zip, has no such
    entries, or every chapter's stripped text is blank.
    """
    names = zip_entry_names(data)

    docs: list[str] = []
    for name in names:
        lower = _ascii_lower(name)
        if (
            lower.endswith(".xhtml") or lower.endswith(".html") or lower.endswith(".htm")
        ) and not lower.startswith("meta-inf/"):
            docs.append(name)
    docs.sort()

    spine = _epub_spine_order(data, names)
    # First index at which each spine entry appears -- `list.index` would
    # find the same first occurrence but re-scan the whole spine per lookup,
    # so build the map once instead.
    spine_position: dict[str, int] = {}
    for i, name in enumerate(spine):
        if name not in spine_position:
            spine_position[name] = i
    not_in_spine = len(spine)  # any value >= len(spine) sorts after every spine hit
    docs.sort(key=lambda n: spine_position.get(n, not_in_spine))

    out_parts: list[str] = []
    out_len = 0  # UTF-8 byte length of the joined output so far
    for entry in docs:
        remaining = MAX_ZIP_ENTRY_BYTES - out_len
        if remaining <= 0:
            break
        xml = read_zip_entry_capped(data, entry, remaining)
        if xml is None:
            continue
        text = strip_html(xml)
        if not text.strip():
            continue
        out_parts.append(text)
        out_parts.append("\n")
        out_len += len(text.encode("utf-8")) + 1

    out = "".join(out_parts)
    return out if out.strip() else None


def _epub_spine_order(data: bytes, names: list[str]) -> list[str]:
    """Reading order from the book's OPF package: `<itemref idref="...">`
    in the spine, resolved through `<item id="..." href="...">` in the
    manifest and made archive-relative. Best-effort -- an unreadable
    package (no `.opf` entry, or it can't be read) just means an empty
    list, which callers treat as "no spine, fall back to name order".
    """
    opf_name = next((n for n in names if _ascii_lower(n).endswith(".opf")), None)
    if opf_name is None:
        return []

    opf = read_zip_entry(data, opf_name)
    if opf is None:
        return []

    base = opf_name.rsplit("/", 1)[0] if "/" in opf_name else ""

    manifest: list[tuple[str, str]] = []
    for chunk in opf.split("<item ")[1:]:
        item_id = xml_attr(chunk, "id")
        href = xml_attr(chunk, "href")
        if item_id is None or href is None:
            continue
        full = href if not base else f"{base}/{href}"
        manifest.append((item_id, full))

    order: list[str] = []
    for chunk in opf.split("<itemref")[1:]:
        idref = xml_attr(chunk, "idref")
        if idref is None:
            continue
        match = next((path for (mid, path) in manifest if mid == idref), None)
        if match is None:
            continue
        order.append(match)

    return order
