import { useMemo, type CSSProperties } from "react";
import * as XLSX from "xlsx";
import * as cptable from "xlsx/dist/cpexcel.full.mjs";
import { stripQuotedCsvFormulas } from "./csvquoting";

XLSX.set_cptable(cptable);

export const DEFAULT_COL_W = 96;
export const MAX_COLS = 512;
const SCAN_LIMIT = 250_000;

export interface SheetTarget {
  sheet?: string;
  range?: string;
}
export interface Props {
  mediaToken?: string | null;
  dataB64?: string | null;
  text?: string | null;
  target?: SheetTarget;
  editable?: boolean;
  onEditCell?: (sheet: string, cell: string, value: string) => void;
  readOnlyReason?: string;
}
export interface GridCell {
  text: string;
  edit: string;
  formula: boolean;
  style?: CSSProperties;
  span: number;
  covered: boolean;
}
export interface SheetShape {
  ws: XLSX.WorkSheet | null;
  totalRows: number;
  totalCols: number;
  widths: number[];
  merges: Map<string, number>;
}
export interface Edit {
  r: number;
  c: number;
  value: string;
  seed: string;
}
export interface Change {
  key: string;
  sheet: string;
  ref: string;
  before: string;
  after: string;
}

export const EMPTY_CELL: GridCell = {
  text: "",
  edit: "",
  formula: false,
  span: 1,
  covered: false,
};

export function parseFailure(error: unknown): string {
  if (
    /password|encrypt/i.test(
      error instanceof Error ? error.message : String(error),
    )
  )
    return "This spreadsheet is protected with a password, so it can't be opened here. Remove the password in Excel and import it again.";
  return "Could not parse this spreadsheet.";
}
export function colorValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as { rgb?: unknown }).rgb;
}
export function color(value: unknown): string | undefined {
  const rgb = colorValue(value);
  if (typeof rgb !== "string") return undefined;
  if (!/^[0-9a-fA-F]{6,8}$/.test(rgb)) return undefined;
  return `#${rgb.length === 8 ? rgb.slice(2) : rgb}`;
}
export function fontEmphasisCss(font: Record<string, unknown>): CSSProperties {
  const css: CSSProperties = {};
  if (font.bold) css.fontWeight = 600;
  if (font.italic) css.fontStyle = "italic";
  if (font.underline) css.textDecoration = "underline";
  return css;
}
export function fontColorCss(font: Record<string, unknown>): CSSProperties {
  const foreground = color(font.color);
  return foreground ? { color: foreground } : {};
}
export function fontSizeCss(font: Record<string, unknown>): CSSProperties {
  if (typeof font.sz !== "number" || font.sz <= 0) return {};
  return { fontSize: `${font.sz}px` };
}
export function fontCss(font: Record<string, unknown> | undefined): CSSProperties {
  if (!font) return {};
  return {
    ...fontEmphasisCss(font),
    ...fontColorCss(font),
    ...fontSizeCss(font),
  };
}
export function fillCss(fill: Record<string, unknown> | undefined): CSSProperties {
  if (!fill || fill.patternType === "none") return {};
  const background = color(fill.fgColor) ?? color(fill.bgColor);
  return background ? { background } : {};
}
export function horizontalAlignment(
  value: unknown,
): CSSProperties["textAlign"] | undefined {
  if (value === "left" || value === "right" || value === "center") return value;
  return undefined;
}
export function alignmentCss(
  alignment: Record<string, unknown> | undefined,
): CSSProperties {
  if (!alignment) return {};
  const css: CSSProperties = {};
  const horizontal = horizontalAlignment(alignment.horizontal);
  if (horizontal) css.textAlign = horizontal;
  if (alignment.wrapText) css.whiteSpace = "normal";
  return css;
}
export function cellStyle(
  cell: XLSX.CellObject | undefined,
): CSSProperties | undefined {
  const style = (cell as { s?: Record<string, unknown> } | undefined)?.s;
  if (!style || typeof style !== "object") return undefined;
  const css = {
    ...fontCss(style.font as Record<string, unknown> | undefined),
    ...fillCss(style.fill as Record<string, unknown> | undefined),
    ...alignmentCss(style.alignment as Record<string, unknown> | undefined),
  };
  return Object.keys(css).length ? css : undefined;
}
export function toGridCell(cell: XLSX.CellObject | undefined): GridCell {
  if (!cell) return EMPTY_CELL;
  const shown = cell.w ?? (cell.v == null ? "" : String(cell.v));
  return {
    text: shown,
    edit: cell.f ? `=${cell.f}` : shown,
    formula: Boolean(cell.f),
    style: cellStyle(cell),
    span: 1,
    covered: false,
  };
}

export function readTextWorkbook(text: string): XLSX.WorkBook {
  const workbook = XLSX.read(text, { type: "string" });
  for (const name of workbook.SheetNames)
    stripQuotedCsvFormulas(workbook.Sheets[name], text);
  return workbook;
}
export function readWorkbook(
  text: string | null | undefined,
  bytes: Uint8Array | null,
): XLSX.WorkBook | null {
  if (text != null) return readTextWorkbook(text);
  if (!bytes) return null;
  return XLSX.read(bytes, { type: "array", cellStyles: true, cellDates: true });
}
export function useWorkbook(
  text: string | null | undefined,
  bytes: Uint8Array | null,
) {
  return useMemo(() => {
    try {
      return { wb: readWorkbook(text, bytes), failure: null as string | null };
    } catch (error) {
      return { wb: null, failure: parseFailure(error) };
    }
  }, [bytes, text]);
}
export function sheetIndexFor(
  workbook: XLSX.WorkBook | null,
  wanted: string | undefined,
): number | null {
  if (!workbook || !wanted) return null;
  const index = workbook.SheetNames.findIndex(
    (name) => name.toLowerCase() === wanted.toLowerCase(),
  );
  return index >= 0 ? index : null;
}
export function activeSheetIndex(
  workbook: XLSX.WorkBook | null,
  sheetIndex: number,
): number {
  if (!workbook) return 0;
  return Math.min(sheetIndex, workbook.SheetNames.length - 1);
}

export function columnWidths(
  columns: Array<{ wpx?: number; wch?: number; hidden?: boolean }>,
  totalCols: number,
): number[] {
  const widths: number[] = [];
  for (let column = 0; column < Math.min(totalCols, MAX_COLS); column += 1) {
    const spec = columns[column];
    if (spec?.hidden) widths.push(0);
    else if (typeof spec?.wpx === "number") widths.push(Math.round(spec.wpx));
    else if (typeof spec?.wch === "number")
      widths.push(Math.round(spec.wch * 7 + 10));
    else widths.push(DEFAULT_COL_W);
  }
  return widths;
}
export function horizontalMerges(ws: XLSX.WorkSheet): Map<string, number> {
  const merges = new Map<string, number>();
  for (const merge of (ws["!merges"] ?? []) as XLSX.Range[]) {
    if (merge.s.r === merge.e.r && merge.e.c > merge.s.c)
      merges.set(`${merge.s.r}:${merge.s.c}`, merge.e.c - merge.s.c + 1);
  }
  return merges;
}
export function worksheetShape(
  workbook: XLSX.WorkBook | null,
  name: string,
): SheetShape {
  const ws = workbook?.Sheets[name];
  const ref = ws?.["!ref"];
  if (!ws || !ref)
    return {
      ws: null,
      totalRows: 0,
      totalCols: 0,
      widths: [],
      merges: new Map(),
    };
  const range = XLSX.utils.decode_range(ref);
  const totalRows = Math.max(0, range.e.r + 1);
  const totalCols = Math.max(0, range.e.c + 1);
  const columns = (ws["!cols"] ?? []) as Array<{
    wpx?: number;
    wch?: number;
    hidden?: boolean;
  }>;
  return {
    ws,
    totalRows,
    totalCols,
    widths: columnWidths(columns, totalCols),
    merges: horizontalMerges(ws),
  };
}
export function worksheetCell(
  ws: XLSX.WorkSheet,
  key: string,
): XLSX.CellObject | undefined {
  if (key.charCodeAt(0) === 33) return undefined;
  return ws[key] as XLSX.CellObject | undefined;
}
export function scanKeys(ws: XLSX.WorkSheet, keys: string[]) {
  let cells = 0;
  let formulas = 0;
  for (const key of keys) {
    const cell = worksheetCell(ws, key);
    if (!cell) continue;
    cells += 1;
    if (cell.f) formulas += 1;
  }
  return { scanned: true, cells, formulas };
}
export function scanSheet(ws: XLSX.WorkSheet | null) {
  if (!ws) return { scanned: false, cells: 0, formulas: 0 };
  const keys = Object.keys(ws);
  if (keys.length > SCAN_LIMIT)
    return { scanned: false, cells: 0, formulas: 0 };
  return scanKeys(ws, keys);
}
export function mergeSpan(sheet: SheetShape, row: number, column: number): number {
  return sheet.merges.get(`${row}:${column}`) ?? 1;
}
export function spannedCell(cell: GridCell, span: number): GridCell {
  if (span > 1) return { ...cell, span };
  return cell;
}
export function gridRow(sheet: SheetShape, row: number, numCols: number): GridCell[] {
  if (!sheet.ws) return [];
  const values: GridCell[] = [];
  let coveredThrough = -1;
  for (let column = 0; column < numCols; column += 1) {
    const cell = toGridCell(
      sheet.ws[
        XLSX.utils.encode_cell({ r: row, c: column })
      ] as XLSX.CellObject,
    );
    if (column <= coveredThrough) {
      values.push({ ...cell, covered: true });
      continue;
    }
    const span = mergeSpan(sheet, row, column);
    if (span > 1) coveredThrough = column + span - 1;
    values.push(spannedCell(cell, span));
  }
  return values;
}
export function gridRows(
  sheet: SheetShape,
  first: number,
  count: number,
  numCols: number,
): GridCell[][] {
  const rows: GridCell[][] = [];
  const last = Math.min(sheet.totalRows, first + count);
  for (let row = first; row < last; row += 1)
    rows.push(gridRow(sheet, row, numCols));
  return rows;
}
