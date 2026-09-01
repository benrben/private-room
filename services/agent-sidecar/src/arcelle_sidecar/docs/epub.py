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
    docs = _ordered_chapter_entries(data, names)
    return _chapter_text_output(data, docs)


def _is_chapter_entry(name: str) -> bool:
    lower = _ascii_lower(name)
    return lower.endswith((".xhtml", ".html", ".htm")) and not lower.startswith(
        "meta-inf/"
    )


def _ordered_chapter_entries(data: bytes, names: list[str]) -> list[str]:
    docs = sorted(name for name in names if _is_chapter_entry(name))
    spine = _epub_spine_order(data, names)
    spine_positions = _spine_positions(spine)
    not_in_spine = len(spine)
    docs.sort(key=lambda name: spine_positions.get(name, not_in_spine))
    return docs


def _spine_positions(spine: list[str]) -> dict[str, int]:
    """Keep each entry's first spine position, matching `list.index`."""
    positions: dict[str, int] = {}
    for position, name in enumerate(spine):
        positions.setdefault(name, position)
    return positions


def _chapter_text(data: bytes, entry: str, remaining: int) -> str | None:
    xml = read_zip_entry_capped(data, entry, remaining)
    if xml is None:
        return None
    text = strip_html(xml)
    return text if text.strip() else None


def _chapter_text_output(data: bytes, docs: list[str]) -> str | None:
    out_parts: list[str] = []
    out_len = 0  # UTF-8 byte length of the joined output so far
    for entry in docs:
        remaining = MAX_ZIP_ENTRY_BYTES - out_len
        if remaining <= 0:
            break
        text = _chapter_text(data, entry, remaining)
        if text is None:
            continue
        out_parts.append(text)
        out_parts.append("\n")
        out_len += len(text.encode("utf-8")) + 1

    out = "".join(out_parts)
    return out if out.strip() else None


def _opf_entry_name(names: list[str]) -> str | None:
    for name in names:
        if _ascii_lower(name).endswith(".opf"):
            return name
    return None


def _read_opf(data: bytes, names: list[str]) -> tuple[str, str] | None:
    opf_name = _opf_entry_name(names)
    if opf_name is None:
        return None

    opf = read_zip_entry(data, opf_name)
    if opf is None:
        return None

    base = opf_name.rsplit("/", 1)[0] if "/" in opf_name else ""
    return opf, base


def _manifest_item(chunk: str, base: str) -> tuple[str, str] | None:
    item_id = xml_attr(chunk, "id")
    href = xml_attr(chunk, "href")
    if item_id is None or href is None:
        return None
    full = href if not base else f"{base}/{href}"
    return item_id, full


def _opf_manifest(opf: str, base: str) -> list[tuple[str, str]]:
    manifest: list[tuple[str, str]] = []
    for chunk in opf.split("<item ")[1:]:
        item = _manifest_item(chunk, base)
        if item is not None:
            manifest.append(item)
    return manifest


def _manifest_path(manifest: list[tuple[str, str]], item_id: str) -> str | None:
    for manifest_id, path in manifest:
        if manifest_id == item_id:
            return path
    return None


def _resolved_spine_order(opf: str, manifest: list[tuple[str, str]]) -> list[str]:
    order: list[str] = []
    for chunk in opf.split("<itemref")[1:]:
        item_id = xml_attr(chunk, "idref")
        if item_id is None:
            continue
        path = _manifest_path(manifest, item_id)
        if path is not None:
            order.append(path)
    return order


def _epub_spine_order(data: bytes, names: list[str]) -> list[str]:
    """Reading order from the book's OPF package: `<itemref idref="...">`
    in the spine, resolved through `<item id="..." href="...">` in the
    manifest and made archive-relative. Best-effort -- an unreadable
    package (no `.opf` entry, or it can't be read) just means an empty
    list, which callers treat as "no spine, fall back to name order".
    """
    opf_and_base = _read_opf(data, names)
    if opf_and_base is None:
        return []
    opf, base = opf_and_base
    return _resolved_spine_order(opf, _opf_manifest(opf, base))
