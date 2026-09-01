"""Native extraction for pre-2007 XLS and OpenDocument spreadsheets."""

from __future__ import annotations

import io

import xlrd
from odf.opendocument import load as _odf_load
from odf.table import Table, TableRow

from .legacy_common import utf8_len

try:
    import odf.teletype as _teletype
except ImportError:  # pragma: no cover - odfpy always ships this module
    _teletype = None


def _trim_float(f: float) -> str:
    if abs(f) < 1e15 and f == int(f):
        return str(int(f))
    return str(f)


def extract_legacy_spreadsheet(data: bytes, ext: str, max_chars: int) -> str | None:
    sheets = _spreadsheet_sheets(data, ext)
    if sheets is None:
        return None
    return _render_legacy_sheets(sheets, max_chars)


def _spreadsheet_sheets(data: bytes, ext: str) -> list[tuple[str, list[list[str]]]] | None:
    if ext == "xls":
        return _xls_sheets(data)
    if ext == "ods":
        return _ods_sheets(data)
    return None


def _render_legacy_sheets(
    sheets: list[tuple[str, list[list[str]]]], max_chars: int
) -> str | None:
    out: list[str] = []
    total_len = 0
    for name, rows in sheets:
        total_len, truncated = _append_legacy_sheet(
            name, rows, out, total_len, max_chars
        )
        if truncated:
            out.append("\n… (truncated)\n")
            return _legacy_output(out)
    return _legacy_output(out)


def _append_legacy_sheet(
    name: str,
    rows: list[list[str]],
    out: list[str],
    total_len: int,
    max_chars: int,
) -> tuple[int, bool]:
    if not _sheet_has_content(rows):
        return total_len, False
    header = f"--- {name} ---\n"
    out.append(header)
    total_len += utf8_len(header)
    for row in rows:
        if not _row_has_content(row):
            continue
        total_len = _append_legacy_row(row, out, total_len)
        if total_len > max_chars:
            return total_len, True
    return total_len, False


def _sheet_has_content(rows: list[list[str]]) -> bool:
    return any(_row_has_content(row) for row in rows)


def _row_has_content(row: list[str]) -> bool:
    return any(cell.strip() for cell in row)


def _append_legacy_row(row: list[str], out: list[str], total_len: int) -> int:
    line = "\t".join(row) + "\n"
    out.append(line)
    return total_len + utf8_len(line)


def _legacy_output(out: list[str]) -> str | None:
    result = "".join(out)
    return result if result.strip() else None


def _xls_sheets(data: bytes) -> list[tuple[str, list[list[str]]]] | None:
    try:
        book = xlrd.open_workbook(file_contents=data, logfile=io.StringIO())
    except Exception:
        return None
    sheets: list[tuple[str, list[list[str]]]] = []
    for sheet in book.sheets():
        rows = [
            [_xls_cell_value(cell, book.datemode) for cell in sheet.row(r)]
            for r in range(sheet.nrows)
        ]
        sheets.append((sheet.name, rows))
    return sheets


def _xls_cell_value(cell: xlrd.sheet.Cell, datemode: int) -> str:
    if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
        return ""
    return _xls_nonempty_cell_value(cell, datemode)


def _xls_nonempty_cell_value(cell: xlrd.sheet.Cell, datemode: int) -> str:
    if cell.ctype == xlrd.XL_CELL_NUMBER:
        return _trim_float(float(cell.value))
    if cell.ctype == xlrd.XL_CELL_BOOLEAN:
        return "true" if cell.value else "false"
    if cell.ctype == xlrd.XL_CELL_DATE:
        return _xls_date_cell_value(cell.value, datemode)
    if cell.ctype == xlrd.XL_CELL_ERROR:
        return xlrd.error_text_from_code.get(cell.value, str(cell.value))
    return str(cell.value)


def _xls_date_cell_value(value: float, datemode: int) -> str:
    try:
        return str(xlrd.xldate_as_datetime(value, datemode))
    except (xlrd.XLDateError, ValueError):
        return _trim_float(float(value))


_MAX_ODS_REPEAT = 1024
_ODS_NUMERIC_VALUE_TYPES = frozenset(("float", "percentage", "currency"))
_ODS_TYPED_VALUE_ATTRIBUTES = {
    "boolean": "booleanvalue",
    "date": "datevalue",
    "time": "timevalue",
}


def _repeat_count(raw: str | None) -> int:
    if raw is None:
        return 1
    try:
        n = int(raw)
    except ValueError:
        return 1
    return max(1, min(n, _MAX_ODS_REPEAT))


def _ods_sheets(data: bytes) -> list[tuple[str, list[list[str]]]] | None:
    try:
        doc = _odf_load(io.BytesIO(data))
    except Exception:
        return None
    sheets: list[tuple[str, list[list[str]]]] = []
    for tbl in doc.getElementsByType(Table):
        name = tbl.getAttribute("name") or ""
        rows: list[list[str]] = []
        for row_el in tbl.getElementsByType(TableRow):
            cells = _ods_row_values(row_el)
            repeat = _repeat_count(row_el.getAttribute("numberrowsrepeated"))
            for _ in range(repeat):
                rows.append(cells)
        sheets.append((name, rows))
    return sheets


def _ods_row_values(row) -> list[str]:
    values: list[str] = []
    for child in row.childNodes:
        local_name = child.qname[1] if hasattr(child, "qname") else None
        if local_name not in ("table-cell", "covered-table-cell"):
            continue
        value = _ods_cell_value(child)
        repeat = _repeat_count(child.getAttribute("numbercolumnsrepeated"))
        values.extend([value] * repeat)
    return values


def _ods_cell_value(cell) -> str:
    typed_value = _ods_typed_value(cell, cell.getAttribute("valuetype"))
    if typed_value is not None:
        return typed_value
    return _teletype.extractText(cell) if _teletype is not None else str(cell)


def _ods_typed_value(cell, value_type: str | None) -> str | None:
    if value_type in _ODS_NUMERIC_VALUE_TYPES:
        return _ods_numeric_value(cell)
    attribute = _ODS_TYPED_VALUE_ATTRIBUTES.get(value_type)
    return cell.getAttribute(attribute) if attribute is not None else None


def _ods_numeric_value(cell) -> str | None:
    raw = cell.getAttribute("value")
    if raw is None:
        return None
    try:
        return _trim_float(float(raw))
    except ValueError:
        return None
