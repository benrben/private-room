"""XLSX text extraction.

Port of `src-tauri/src/extraction/xlsx.rs`'s `extract_xlsx`. The zip-bomb
guards it also defines (`zip_declared_size_within`/`zip_inflated_size_within`)
are already ported onto the shared `arcelle_sidecar.docs.xml_utils` module
-- this file imports them rather than redefining them, exactly as the
migration brief asks.

------------------------------------------------------------------- why
The old xlsx reader only read `xl/sharedStrings.xml`, which interns STRING
cells only -- numeric cells live inline in each worksheet's own XML, so an
all-numeric sheet (a budget, a table of measurements) extracted to nothing
and the model saw the file as empty. `umya-spreadsheet` in Rust parses the
FULL workbook object model, so numbers/dates/formula results all land in
the extracted text; `openpyxl` is this port's equivalent, per the
migration plan's own recommendation.

---------------------------------------------------------------- bounds
Same three ceilings as the Rust source, deliberately wide (a real export
has to land WHOLE): `MAX_ROWS`/`MAX_COLS` bound the walked row/column
range; `MAX_TEXT_CHARS` bounds the accumulated output size -- compared
against Python string LENGTH (Unicode code points), not the Rust source's
UTF-8 BYTE length, since there is no cheap byte-length view of a growing
Python string buffer without re-encoding on every check. The 16 MiB budget
is generous enough on either side of that difference that it never changes
which sheets get truncated in any of this module's tests, and the
Python-side constant is itself named `MAX_TEXT_CHARS`, not bytes.
`MAX_XLSX_DECOMPRESSED` bounds how much the archive is allowed to
decompress to BEFORE the workbook is ever handed to openpyxl, which --
like umya -- fully loads into memory with no size guard of its own.

------------------------------------------------- walking populated cells ONLY
The Rust source's central perf fix is walking the sheet's POPULATED cells
(`ws.cells_sorted()`), never every coordinate in its rows x columns
bounding rectangle: a sheet holding two values whose highest cell sits at
row 40 000 / column 1 000 spans 40 million coordinates, and the original,
buggy version that walked all of them cost whole seconds with the room
lock held, over a few hundred bytes of real content.

The natural-looking Python translation -- `ws.iter_rows(values_only=True)`
in `read_only` mode -- does NOT have this property, confirmed empirically
(see `tests/test_docs_xlsx.py::test_sparse_sheet_costs_its_cells...`
which pins this down): read-only mode streams the XML row-by-row, but
`ReadOnlyWorksheet._cells_by_row`/`_get_row` still PAD every row they
yield out to the full column width. A row with no `<row>` element at all
reuses one cached all-`None` tuple rather than allocating a fresh one, but
the caller still receives that tuple and must scan every element of it to
find the populated ones -- so the walk's cost is proportional to
rows x columns, just with a cheap constant per empty cell rather than an
allocation. Measured directly against this file's own sparse-sheet
scenario (two real cells, one at row 40 000 / column 1 000): the plain
`iter_rows(values_only=True)` translation took ~1.0s -- comfortably under
the test's 3s budget, but nowhere near umya's ~20ms and not actually
cell-count-proportional; a genuinely sparse workbook nearer the real
`MAX_ROWS` x `MAX_COLS` ceiling (100 000 x 1 000) would be meaningfully
slower, reintroducing a shadow of the exact cost class this whole module
exists to avoid.

So this port reaches one layer deeper, into the same `WorkSheetParser`
that `ReadOnlyWorksheet._cells_by_row` itself is built on
(`openpyxl.worksheet._reader.WorkSheetParser`, fed the same private
`ws._get_source()` / `ws._shared_strings` / `wb.data_only` / `wb.epoch` /
`wb._date_formats` / `wb._timedelta_formats` that method already
assembles internally) to stream only the `<c>` elements actually present
in each `<row>` -- no per-row padding, no synthesized rows for gaps --
which is the real cell-count-proportional walk umya's `cells_sorted()`
gives Rust for free (measured at ~0.1ms for the same scenario). This
reaches past openpyxl's public surface into a private module; it is the
same private-attribute assembly `ReadOnlyWorksheet` already performs
internally, not a deeper coupling than that, and it is covered by this
file's own sparse-sheet timing test, so a future openpyxl upgrade that
changes these internals fails loudly here rather than silently
reintroducing the bounding-rectangle cost.

Containment note: like the Rust source, `extract_xlsx` itself only
guards the INITIAL workbook parse (`.ok()?` in Rust; a broad `except
Exception` here) and the zip-bomb precheck. A failure partway through the
cell walk (a corrupt XML fragment discovered mid-stream) is not
separately caught here, mirroring the Rust source's own structure: that
containment lives one layer up, in `extract_text`'s `contain_parser_panic`
wrapper, which is out of scope for this port (only `extract_xlsx` was
requested).
"""

from __future__ import annotations

import datetime
import io
from typing import Any, Iterator

import openpyxl
from openpyxl.worksheet._reader import WorkSheetParser

from arcelle_sidecar.docs.xml_utils import (
    zip_declared_size_within,
    zip_inflated_size_within,
)

# Bounds on how much of a workbook becomes searchable text. Deliberately
# wide -- a real export has to land WHOLE, and a tight cut would silently
# hide most of a big sheet from search and from the model while a viewer
# still showed every row. Whatever these do cut is ANNOUNCED in the text.
MAX_ROWS: int = 100_000
MAX_COLS: int = 1_000

# A second, absolute ceiling: 100 000 x 1 000 cells would be a multi-GB
# string. Whichever bound bites first, the truncation is reported.
MAX_TEXT_CHARS: int = 16 * 1024 * 1024

# openpyxl fully decompresses the workbook into an object model BEFORE the
# row/col bounds above apply, so a small zip bomb could balloon memory --
# exactly the risk umya has in Rust. Declared sizes can lie, so the
# declared-size check is only a fast path for honest oversized files; the
# streaming re-count of ACTUAL inflated bytes is the real guard. Generous
# on purpose -- a genuinely huge all-numeric sheet must still extract.
MAX_XLSX_DECOMPRESSED: int = 512 * 1024 * 1024

# NOTE: `rows_total`/`cols_total` inside `extract_xlsx` are NOT simply
# `ws.max_row`/`ws.max_column` (openpyxl's declared `<dimension>` metadata,
# which a non-openpyxl writer can understate) -- see the long comment at
# their computation site for why blindly trusting that field silently drops
# real trailing data, and how umya's `highest_row()`/`highest_column()`
# avoid the problem entirely by having no separate "declared" source at all.


def extract_xlsx(data: bytes) -> str | None:
    """Extract every populated cell of every worksheet as text, numbers and
    strings alike, in workbook sheet order. `None` for anything that isn't
    a readable workbook, over either decompression-bomb cap, or whose
    extracted text is all-whitespace.
    """
    if not zip_declared_size_within(data, MAX_XLSX_DECOMPRESSED):
        return None
    if not zip_inflated_size_within(data, MAX_XLSX_DECOMPRESSED):
        return None
    try:
        workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception:
        return None

    out_parts: list[str] = []
    out_len = 0

    def append(text: str) -> None:
        nonlocal out_len
        out_parts.append(text)
        out_len += len(text)

    try:
        for ws in workbook.worksheets:
            # `ws.max_row`/`ws.max_column` come from the sheet's own
            # `<dimension>` metadata (read_only mode parses it up front,
            # never a live rescan). This is NOT the same source as umya's
            # `highest_row()`/`highest_column()`: umya has no separate
            # "declared bounds" concept at all -- it fully parses every
            # `<c>` element into an in-memory cell collection first, and
            # `highest_row()`/`highest_column()` simply read the max
            # coordinate actually PRESENT in that collection, so no real
            # cell can ever exceed it. openpyxl's `<dimension>` element, by
            # contrast, is separate metadata a writer can get wrong -- a
            # workbook from some other tool can declare a SMALLER extent
            # than it actually contains (a stale/miscomputed dimension
            # tag). Trusting it blindly here would silently drop every
            # real cell beyond the lied-about bound, with NO truncation
            # note at all (since the reported `rows_total`/`cols_total`
            # would be the same too-small lie) -- exactly the "silently
            # half-read export" failure this module's own truncation
            # note exists to rule out. Confirmed empirically: a workbook
            # patched to declare `<dimension ref="A1:A1"/>` while actually
            # holding a cell at row 10/column 5 made this port drop that
            # cell outright before this fix.
            #
            # So `rows_total`/`cols_total` below are the MAX of the
            # declared bound and whatever the walk actually observes --
            # never smaller than reality, matching umya's guarantee -- and
            # the walk itself gates on the fixed `MAX_ROWS`/`MAX_COLS`
            # ceilings directly rather than on a value derived from the
            # (possibly-lying) declared bound. `None` when a sheet carries
            # no dimension element at all (not something openpyxl's own
            # writer ever produces, but a file from another tool might
            # omit it) -- treated as 0, matching umya reporting 0 for a
            # truly dimensionless sheet.
            #
            # One narrower gap remains, accepted deliberately: if the
            # declared dimension lies the OTHER way -- claiming a sheet is
            # completely empty (0) when it actually holds data -- this
            # sheet is skipped before ever walking it, since the skip
            # check below is the cheap pre-filter and nothing has been
            # observed yet at that point. Fully closing that would mean
            # unconditionally walking every worksheet regardless of its
            # declared dimension, which is a larger change for a rarer
            # failure mode (an "empty" lie is a stranger thing for a real
            # writer to produce than an "understated" one) than the
            # concretely-demonstrated bug this fix closes.
            declared_rows = ws.max_row or 0
            declared_cols = ws.max_column or 0
            if declared_rows == 0 or declared_cols == 0:
                continue
            append(f"[sheet: {ws.title}]\n")

            cells: list[str] = []
            row_no = 0
            max_row_seen = 0
            max_col_seen = 0
            last_row: int | None = None
            for cell in _iter_populated_cells(ws):
                row = cell["row"]
                col = cell["column"]
                # Track the TRUE extent from every cell actually present,
                # regardless of whether it ends up gated out below -- this
                # is what makes `rows_total`/`cols_total` trustworthy even
                # when the declared dimension understates them.
                if row > max_row_seen:
                    max_row_seen = row
                if col > max_col_seen:
                    max_col_seen = col
                if row <= 0 or col <= 0 or row > MAX_ROWS or col > MAX_COLS:
                    continue
                value = cell["value"]
                if value is None or value == "":
                    continue
                if row != row_no:
                    if cells:
                        # " | ", not a tab: `normalize_whitespace` runs
                        # over every extractor's output and collapses
                        # tabs, which would flatten the grid into a run of
                        # words and make empty cells vanish entirely -- so
                        # the model would read "Name Total" for
                        # "Name | (blank) | Total" and could line the
                        # columns up wrong.
                        append(" | ".join(cells))
                        append("\n")
                        cells = []
                    if out_len >= MAX_TEXT_CHARS:
                        last_row = row_no
                        break
                    row_no = row
                if len(cells) < col:
                    cells.extend([""] * (col - len(cells)))
                cells[col - 1] = _format_cell_value(value)
            if cells:
                append(" | ".join(cells))
                append("\n")

            rows_total = max(declared_rows, max_row_seen)
            cols_total = max(declared_cols, max_col_seen)
            max_row = min(rows_total, MAX_ROWS)
            max_col = min(cols_total, MAX_COLS)
            if last_row is None:
                # The walk ran to completion (no MAX_TEXT_CHARS break), so
                # everything up to the clamp was read.
                last_row = max_row

            # Say so when anything was left out -- a silently half-read
            # export is worse than a short one, because nothing downstream
            # can tell.
            if last_row < rows_total or cols_total > max_col:
                append(
                    f'[sheet "{ws.title}" truncated: read rows 1-{last_row} of '
                    f"{rows_total}, columns 1-{max_col} of {cols_total}]\n"
                )
            append("\n")
    finally:
        workbook.close()

    out = "".join(out_parts)
    return None if out.strip() == "" else out


def _iter_populated_cells(ws: Any) -> Iterator[dict]:
    """Yield every actually-stored cell (`{"row", "column", "value", ...}`)
    of a read-only worksheet in its own XML order -- no filler for gaps
    within a row, no synthesized rows for entirely empty ones. See the
    module docstring for why this bypasses `ws.iter_rows()`.
    """
    with ws._get_source() as source:
        parser = WorkSheetParser(
            source,
            ws._shared_strings,
            data_only=ws.parent.data_only,
            epoch=ws.parent.epoch,
            date_formats=ws.parent._date_formats,
            timedelta_formats=ws.parent._timedelta_formats,
        )
        for _row_no, row_cells in parser.parse():
            yield from row_cells


def _format_cell_value(value: object) -> str:
    """Render a cell's raw Python value the way umya's `cell.value()`
    would -- numbers as plain numbers, with no artificial trailing `.0` on
    a value that is a whole number. Python's own `str(float)` always keeps
    that trailing zero (`str(100.0) == "100.0"`) -- worth calling out
    since it is exactly the kind of thing that looks right until checked:
    openpyxl's OWN writer never round-trips a whole-number float back as
    a literal `"100.0"` (it writes/reads `"100"`, landing as a Python
    `int`), so this branch only ever fires for a workbook written by some
    OTHER tool that stored an explicit trailing-`.0` numeric string --
    exactly the case this module's numeric test would miss if it only
    checked `"12000" in text`, which a stray `"12000.0"` also satisfies.
    """
    if isinstance(value, bool):
        # Excel shows a boolean cell as "TRUE"/"FALSE", not "1"/"0" --
        # checked first since `bool` is a subclass of `int` in Python.
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return str(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time, datetime.timedelta)):
        return str(value)
    return str(value)
