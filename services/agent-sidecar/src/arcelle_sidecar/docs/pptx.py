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
    output = _BudgetedText(budget)
    _append_slides(data, _slide_entries(names), output)
    _append_chart_and_diagram_text(data, names, output)
    return output.result()


class _BudgetedText:
    """The extracted text and the shared byte budget used to read it."""

    def __init__(self, budget: int) -> None:
        self.budget = budget
        self.chunks: list[str] = []
        self.out_bytes = 0

    def remaining(self) -> int:
        return self.budget - self.out_bytes

    def emit(self, text: str) -> None:
        self.chunks.append(text)
        self.out_bytes += len(text.encode("utf-8"))

    def result(self) -> str | None:
        output = "".join(self.chunks)
        return output if output.strip() else None


def _slide_entries(names: list[str]) -> list[str]:
    return sorted(
        (name for name in names if name.startswith(_SLIDE_PREFIX) and name.endswith(_SLIDE_SUFFIX)),
        key=lambda name: slide_number(name) or 0,
    )


def _append_slides(data: bytes, slides: list[str], output: _BudgetedText) -> None:
    for index, entry in enumerate(slides):
        # The per-slide cap alone lets hundreds of near-cap slides balloon
        # the total, so all slides share one aggregate budget; downstream
        # truncates extracted text anyway, so stopping early loses nothing.
        if output.remaining() <= 0:
            break
        _append_slide_body(data, entry, index, output)
        _append_slide_notes(data, entry, index, output)


def _append_slide_body(data: bytes, entry: str, index: int, output: _BudgetedText) -> None:
    xml = read_zip_entry_capped(data, entry, output.remaining())
    if xml is not None:
        output.emit(f"[slide {index + 1}]\n" + xml_paras_to_text(xml, "</a:p>") + "\n")


def _append_slide_notes(data: bytes, entry: str, index: int, output: _BudgetedText) -> None:
    # The speaker notes belong to the slide, and in a real deck they carry
    # the argument, the numbers and the narration the headline only hints
    # at. Reading slide bodies alone left the assistant answering from
    # titles, confidently missing content plainly in the file.
    if output.remaining() <= 0:
        return
    notes_entry = notes_part(data, entry, _slide_number_or_index(entry, index))
    if notes_entry is None:
        return
    notes_xml = read_zip_entry_capped(data, notes_entry, output.remaining())
    if notes_xml is None:
        return
    notes = xml_paras_to_text(notes_xml, "</a:p>")
    # The notes part of an un-annotated slide still exists and still renders
    # the slide number; only real prose is worth it.
    if len(notes.split()) <= 1:
        return
    output.emit(f"[slide {index + 1} notes]\n" + notes + "\n")


def _slide_number_or_index(entry: str, index: int) -> int:
    number = slide_number(entry)
    return index + 1 if number is None else number


def _append_chart_and_diagram_text(
    data: bytes, names: list[str], output: _BudgetedText
) -> None:
    # Chart data and SmartArt/diagram text live in their own parts, so a
    # deck whose numbers are all in charts extracted to headings only.
    for prefix, label in (("ppt/charts/chart", "chart"), ("ppt/diagrams/data", "diagram")):
        _append_labeled_parts(data, _matching_xml_parts(names, prefix), label, output)


def _matching_xml_parts(names: list[str], prefix: str) -> list[str]:
    return sorted(name for name in names if name.startswith(prefix) and name.endswith(".xml"))


def _append_labeled_parts(
    data: bytes, entries: list[str], label: str, output: _BudgetedText
) -> None:
    for entry in entries:
        if output.remaining() <= 0:
            break
        _append_labeled_part(data, entry, label, output)


def _append_labeled_part(
    data: bytes, entry: str, label: str, output: _BudgetedText
) -> None:
    xml = read_zip_entry_capped(data, entry, output.remaining())
    if xml is None:
        return
    text = xml_paras_to_text(xml, "</a:p>")
    if len(text.split()) <= 1:
        return
    output.emit(f"[{label}]\n" + text + "\n")


def slide_number(entry: str) -> int | None:
    """The `N` in `ppt/slides/slideN.xml` -- the archive order the slides
    arrive in is not necessarily that numbering.
    """
    s = _slide_file_stem(entry)
    # `str::parse::<u32>()`: an optional single leading `+`, decimal digits
    # only (no underscores, no whitespace -- unlike Python's own lenient
    # `int()`), and the value must fit in 32 bits.
    digits = s[1:] if s.startswith("+") else s
    if not _is_decimal_digits(digits):
        return None
    value = int(digits)
    return value if value <= 0xFFFFFFFF else None


def _slide_file_stem(entry: str) -> str:
    stem = entry
    while stem.startswith(_SLIDE_PREFIX):
        stem = stem[len(_SLIDE_PREFIX) :]
    while stem.endswith(_SLIDE_SUFFIX):
        stem = stem[: -len(_SLIDE_SUFFIX)]
    return stem


def _is_decimal_digits(text: str) -> bool:
    return bool(text) and all(char in "0123456789" for char in text)


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
        target = _notes_target(tag)
        if target is not None:
            return target
    return None


def _notes_target(tag: str) -> str | None:
    if not _is_notes_relationship(tag):
        return None
    return xml_attr(tag, "Target")


def _is_notes_relationship(tag: str) -> bool:
    if not tag.startswith("Relationship"):
        return False
    kind = xml_attr(tag, "Type")
    return kind is not None and kind.endswith("/notesSlide")


def resolve_part(part_dir: str, target: str) -> str:
    """A relationship target resolved against the folder of the part that
    declared it: `../notesSlides/notesSlide1.xml` from `ppt/slides` is
    `ppt/notesSlides/notesSlide1.xml`. Resolving against the `_rels` folder
    the mapping happens to live in yields a name no deck contains.
    """
    if target.startswith("/"):
        return target[1:]
    return _resolve_relative_part(part_dir, target)


def _resolve_relative_part(part_dir: str, target: str) -> str:
    parts = [s for s in part_dir.split("/") if s]
    for seg in target.split("/"):
        if _is_part_segment(seg):
            _append_part_segment(parts, seg)
    return "/".join(parts)


def _is_part_segment(segment: str) -> bool:
    return segment not in ("", ".")


def _append_part_segment(parts: list[str], segment: str) -> None:
    if segment == "..":
        if parts:
            parts.pop()
        return
    parts.append(segment)


__all__ = [
    "extract_pptx",
    "slide_number",
    "notes_part",
    "notes_rel_target",
    "resolve_part",
]
