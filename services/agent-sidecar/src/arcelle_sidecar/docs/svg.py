"""SVG text extraction: the words inside `<title>`, `<desc>`, `<text>`,
`<tspan>` and `<textPath>` elements. A diagram's labels are usually the only
searchable thing in it.

Port of the SVG section of `src-tauri/src/extraction/data.rs`
(`extract_svg`, `strip_inner_tags`), plus a local copy of the
`push_capped`/`MAX_DERIVED_CHARS` bound from lines 1-35 of that file
(matching the established pattern in this codebase's sibling `docs.mail`
and `docs.notebook` modules, which each carry their own copy of the same
bound rather than sharing one that isn't genuinely shared elsewhere yet).

Deliberately NOT `strip_html` (the sibling `docs.html` module): that reader
DELETES `<svg>...</svg>` whole, on purpose -- inline SVG in a web page is
chrome whose stray path data would crowd out the article. Pointed at a
standalone `.svg` file it therefore returns nothing at all, which is
exactly the bug this module exists to avoid. Only text-bearing elements are
read here, so `d="M0 0 L12 8"` path data never lands in the index as if it
were prose.

Built on the FINAL sibling `arcelle_sidecar.docs.xml_utils` module's
`decode_basic_entities` rather than redefining it.

----------------------------------------------------------------- ASCII fold

Same alignment concern as `docs.html`: the Rust source searches for element
names in an ASCII-lowercased COPY of the string, then slices the ORIGINAL
string using offsets found in that copy. Python's Unicode-aware `str.lower()`
is not length-preserving (e.g. Turkish `İ` folds to two code points), which
would shift every later offset out of alignment. `_ascii_lower` below folds
only `A`-`Z` to `a`-`z` and leaves every other character (including
non-ASCII ones) completely unchanged, so the search copy stays exactly the
same length -- and character-for-character aligned with the original at
every index -- no matter what it contains. Element names are always ASCII,
so this loses nothing.

------------------------------------------------------------- name boundary

Searching for `<text` inside e.g. `<textPath>...` would otherwise falsely
match: the fix is to require that the character immediately following the
element name is whitespace, `>`, or `/` before accepting a match. A false
match (the name is merely a prefix of a longer one) resumes the search from
just past the element NAME, not from just after the `<` -- so scanning for
`<text` inside `<textPath ...>` skips the whole false prefix in one step
rather than re-finding it byte by byte.
"""

from __future__ import annotations

from collections.abc import Iterator

from arcelle_sidecar.docs.xml_utils import decode_basic_entities

# Bound on how much text this reader contributes to the index -- same value
# and purpose as `extraction/data.rs`'s module-wide `MAX_DERIVED_CHARS`. This
# module owns its own copy rather than importing one from elsewhere, matching
# this codebase's established pattern for a bound that isn't genuinely shared
# yet (see `arcelle_sidecar.docs.mail`/`docs.notebook`'s identical local
# copies).
_MAX_DERIVED_CHARS = 8 * 1024 * 1024

# Scanned in this order, matching the Rust source's `TEXT_ELEMENTS` slice
# exactly -- `text` must come before `textPath` so a `<textPath>` element's
# body is not double-counted as a false `<text>` match (the boundary check
# below also independently prevents that).
_TEXT_ELEMENTS: tuple[str, ...] = ("title", "desc", "text", "tspan", "textPath")


def _ascii_lower(s: str) -> str:
    """`str::to_ascii_lowercase` -- fold only 'A'-'Z', leave every other
    character (including non-ASCII ones) untouched, so the result stays
    exactly as long as `s` and aligned with it index-for-index. Deliberately
    NOT `str.lower()` (Unicode-aware, can change length -- see module
    docstring).
    """
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in s)


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


def _tag_depth_after(c: str, depth: int) -> int | None:
    """Return the new tag depth for an angle bracket, or `None` for text."""
    if c == "<":
        return depth + 1
    if c == ">":
        return depth - 1 if depth > 0 else depth
    return None


def _strip_inner_tags(s: str) -> str:
    """Drop any tags inside an element body, keeping the characters between
    them, then entity-decode what remains.
    """
    out: list[str] = []
    depth = 0
    for c in s:
        updated_depth = _tag_depth_after(c, depth)
        if updated_depth is not None:
            depth = updated_depth
            continue
        if depth == 0:
            out.append(c)
    return decode_basic_entities("".join(out))


def _has_tag_name_boundary(lower: str, after_name: int) -> bool:
    if after_name >= len(lower):
        return False
    boundary = lower[after_name]
    return boundary.isspace() or boundary in (">", "/")


def _find_element_start(lower: str, element: str, from_idx: int) -> int | None:
    """Find the next opening tag whose name is not only a longer-name prefix."""
    open_tag = _ascii_lower(f"<{element}")
    while True:
        start = lower.find(open_tag, from_idx)
        if start == -1:
            return None
        after_name = start + len(open_tag)
        if _has_tag_name_boundary(lower, after_name):
            return start
        from_idx = after_name


def _element_body_bounds(lower: str, element: str, start: int) -> tuple[int, int] | None:
    """Return the content offsets of a complete text-bearing SVG element."""
    body_rel = lower.find(">", start)
    if body_rel == -1:
        return None
    body_at = body_rel + 1
    end = lower.find(_ascii_lower(f"</{element}>"), body_at)
    if end == -1:
        return None
    return body_at, end


def _element_bodies(raw: str, lower: str, element: str) -> Iterator[str]:
    """Yield complete bodies for one SVG text-bearing element name."""
    from_idx = 0
    close_length = len(f"</{element}>")
    while True:
        start = _find_element_start(lower, element, from_idx)
        if start is None:
            return
        bounds = _element_body_bounds(lower, element, start)
        if bounds is None:
            return
        body_at, end = bounds
        yield raw[body_at:end]
        from_idx = end + close_length


def extract_svg(raw: str) -> str | None:
    """The words inside an SVG: `<title>`, `<desc>`, `<text>`, `<tspan>` and
    `<textPath>` content, in that element order.
    """
    out: list[str] = []
    total_len = [0]
    lower = _ascii_lower(raw)
    for element in _TEXT_ELEMENTS:
        for body in _element_bodies(raw, lower, element):
            inner = _strip_inner_tags(body).strip()
            if inner:
                _push_capped(out, inner, total_len)
                _push_capped(out, "\n", total_len)
    result = "".join(out)
    return result if result.strip() else None
