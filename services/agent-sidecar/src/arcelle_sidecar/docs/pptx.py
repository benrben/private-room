"""PPTX text extraction: slide bodies, speaker notes, chart/diagram text.

Port of `src-tauri/src/extraction/pptx.rs`. Built entirely on the shared
OOXML zip/text primitives in the sibling `arcelle_sidecar.docs.xml_utils`
module (`zip_entry_names`, `read_zip_entry_capped`, `xml_attr`,
`xml_paras_to_text`) rather than redefining any of them.

------------------------------------------------------------------- ordering

Slides are read in NUMERIC order (the `N` in `ppt/slides/slideN.xml`), not
archive order -- a deck's slides are not guaranteed to be stored in that
order. A missing/unparseable number sorts as 0, at the front, matching the
Rust source's `.unwrap_or(0)` sort key exactly.

All slides, their notes, and the trailing chart/diagram parts share ONE
aggregate byte budget (`MAX_ZIP_ENTRY_BYTES` by default via `extract_pptx`)
tracked across the whole walk -- not a fresh per-entry cap each time -- so a
deck of hundreds of near-cap slides can't balloon the total output;
downstream truncates the extracted text anyway, so stopping early loses
nothing. The running total is measured in UTF-8 BYTES of the accumulated
output (mirroring the Rust `String::len()` this ports, which is a byte
count), not Python's character-counting `len()`, so a non-ASCII deck (a
Hebrew deck, say) is capped the same way the Rust binary caps it.

--------------------------------------------------------------- speaker notes

`notes_part` resolves a slide's notes THROUGH ITS OWN `_rels` sidecar
first, falling back to the numeric guess `notesSlideN.xml` only when that
rels part is missing or unreadable. This ordering is load-bearing, not
cosmetic: `notesSlideN.xml` is numbered in the order notes were CREATED,
not by the slide that owns them, so a deck annotated only on its second
slide still writes `notesSlide1.xml`. Matching purely by number would then
label slide 2's narration as slide 1's -- see
`test_notes_follow_the_slide_rels_not_the_part_number`, the regression this
module exists to prevent.

An un-annotated slide's notes part still exists in the archive and still
renders just the slide number as its only "content", so a notes reading is
only appended when it has MORE THAN ONE whitespace-separated word.
"""

from __future__ import annotations

from .xml_utils import (
    MAX_ZIP_ENTRY_BYTES,
    read_zip_entry_capped,
    xml_attr,
    xml_paras_to_text,
    zip_entry_names,
)

_SLIDE_PREFIX = "ppt/slides/slide"
_SLIDE_SUFFIX = ".xml"


def extract_pptx(data: bytes) -> str | None:
    """Text of a `.pptx` file: slide bodies (in slide-number order), each
    slide's speaker notes when they carry real prose, then chart and
    diagram text. `None` when nothing was extracted (not a readable zip, no
    matching parts, or every part's text was blank).
    """
    return _extract_pptx_budgeted(data, MAX_ZIP_ENTRY_BYTES)


def _extract_pptx_budgeted(data: bytes, budget: int) -> str | None:
    names = zip_entry_names(data)
    slides = sorted(
        (n for n in names if n.startswith(_SLIDE_PREFIX) and n.endswith(_SLIDE_SUFFIX)),
        key=lambda n: slide_number(n) or 0,
    )

    chunks: list[str] = []
    out_bytes = 0

    def remaining() -> int:
        return budget - out_bytes

    def emit(text: str) -> None:
        nonlocal out_bytes
        chunks.append(text)
        out_bytes += len(text.encode("utf-8"))

    for i, entry in enumerate(slides):
        # The per-slide cap alone lets hundreds of near-cap slides balloon
        # the total, so all slides share one aggregate budget; downstream
        # truncates extracted text anyway, so stopping early loses nothing.
        if remaining() <= 0:
            break
        xml = read_zip_entry_capped(data, entry, remaining())
        if xml is not None:
            emit(f"[slide {i + 1}]\n" + xml_paras_to_text(xml, "</a:p>") + "\n")

        # The speaker notes belong to the slide, and in a real deck they
        # carry the argument, the numbers and the narration the headline
        # only hints at. Reading slide bodies alone left the assistant
        # answering from titles, confidently missing content plainly in the
        # file.
        slide_no = slide_number(entry)
        if slide_no is None:
            slide_no = i + 1
        notes_entry = notes_part(data, entry, slide_no) if remaining() > 0 else None
        if notes_entry is not None:
            notes_xml = read_zip_entry_capped(data, notes_entry, remaining())
            if notes_xml is not None:
                notes = xml_paras_to_text(notes_xml, "</a:p>")
                # The notes part of an un-annotated slide still exists and
                # still renders the slide number; only real prose is worth
                # it.
                if len(notes.split()) > 1:
                    emit(f"[slide {i + 1} notes]\n" + notes + "\n")

    # Chart data and SmartArt/diagram text live in their own parts, so a
    # deck whose numbers are all in charts extracted to headings only.
    for prefix, label in (("ppt/charts/chart", "chart"), ("ppt/diagrams/data", "diagram")):
        parts = sorted(n for n in names if n.startswith(prefix) and n.endswith(".xml"))
        for entry in parts:
            if remaining() <= 0:
                break
            xml = read_zip_entry_capped(data, entry, remaining())
            if xml is None:
                continue
            text = xml_paras_to_text(xml, "</a:p>")
            if len(text.split()) > 1:
                emit(f"[{label}]\n" + text + "\n")

    out = "".join(chunks)
    return out if out.strip() else None


def slide_number(entry: str) -> int | None:
    """The `N` in `ppt/slides/slideN.xml` -- the archive order the slides
    arrive in is not necessarily that numbering.
    """
    s = entry
    while s.startswith(_SLIDE_PREFIX):
        s = s[len(_SLIDE_PREFIX) :]
    while s.endswith(_SLIDE_SUFFIX):
        s = s[: -len(_SLIDE_SUFFIX)]
    # `str::parse::<u32>()`: an optional single leading `+`, decimal digits
    # only (no underscores, no whitespace -- unlike Python's own lenient
    # `int()`), and the value must fit in 32 bits.
    digits = s[1:] if s.startswith("+") else s
    if not digits or any(c not in "0123456789" for c in digits):
        return None
    value = int(digits)
    return value if value <= 0xFFFFFFFF else None


def notes_part(data: bytes, slide_entry: str, slide_no: int) -> str | None:
    """The ENTRY NAME (not text) of the slide's notes part, or `None` when
    the slide has none.

    `notesSlideN.xml` is numbered in the order notes were CREATED, not by
    the slide that owns them: a five-slide deck annotated only on slide 5
    contains `notesSlide1.xml`. Matching the numbers therefore reads slide
    5's narration out under slide 1's heading and leaves slide 5 with
    nothing -- the model then cites the wrong slide, and the viewer, which
    resolves through the rels, disagrees with it on screen.

    The slide's own `_rels` sidecar is the deck's answer, so when it can be
    read its silence means "no notes". The numeric guess survives only for
    an archive whose rels part is missing or unreadable, where a guess
    beats nothing.
    """

    def numeric_guess() -> str:
        return f"ppt/notesSlides/notesSlide{slide_no}.xml"

    if "/" not in slide_entry:
        return numeric_guess()
    directory, _, file_name = slide_entry.rpartition("/")
    rels_entry = f"{directory}/_rels/{file_name}.rels"
    rels = read_zip_entry_capped(data, rels_entry, MAX_ZIP_ENTRY_BYTES)
    if rels is None:
        return numeric_guess()
    target = notes_rel_target(rels)
    if target is None:
        return None
    return resolve_part(directory, target)


def notes_rel_target(rels_xml: str) -> str | None:
    """The `Target` of the notes-slide relationship in a `_rels` part.

    Hand-scanned rather than parsed: a rels part is a flat list of empty
    elements and this extractor carries no XML parser. The `Type` attribute
    is what identifies the relationship; the target's spelling is the
    deck's business. `xml_attr` reads either quote style, so a producer
    that writes `Target='...'` does not silently cost the deck all of its
    notes.
    """
    for tag in rels_xml.split("<"):
        if not tag.startswith("Relationship"):
            continue
        kind = xml_attr(tag, "Type")
        if kind is None:
            continue
        if not kind.endswith("/notesSlide"):
            continue
        target = xml_attr(tag, "Target")
        if target is not None:
            return target
    return None


def resolve_part(part_dir: str, target: str) -> str:
    """A relationship target resolved against the folder of the part that
    declared it: `../notesSlides/notesSlide1.xml` from `ppt/slides` is
    `ppt/notesSlides/notesSlide1.xml`. Resolving against the `_rels` folder
    the mapping happens to live in yields a name no deck contains.
    """
    if target.startswith("/"):
        return target[1:]
    parts = [s for s in part_dir.split("/") if s]
    for seg in target.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if parts:
                parts.pop()
        else:
            parts.append(seg)
    return "/".join(parts)


__all__ = [
    "extract_pptx",
    "slide_number",
    "notes_part",
    "notes_rel_target",
    "resolve_part",
]
