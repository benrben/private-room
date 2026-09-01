import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { type CellRect, parseA1Range } from "./highlight";
import { colLetters } from "./csvquoting";
import { useFileBytes } from "./useFileBytes";
import { FormulaBar, EditBanner, Notice, SheetTabs } from "./SheetCells";
import { SheetGrid, SheetNotes } from "./SheetGrid";
import { cellHighlight, useEdits, useGridFocus, useGridView, useSheetSelection } from "./sheetEdits";
import {
  MAX_COLS,
  gridRows,
  scanSheet,
  toGridCell,
  useWorkbook,
  worksheetShape,
  type Change,
  type Edit,
  type GridCell,
  type Props,
  type SheetShape,
} from "./sheetModel";
import "./sheet.css";

export type { SheetTarget } from "./sheetModel";

const ROW_H = 24;

function ColumnCap({ totalCols }: { totalCols: number }) {
  if (totalCols <= MAX_COLS) return null;
  return (
    <div className="viewer-status">{`Showing the first ${MAX_COLS} of ${totalCols.toLocaleString()} columns (up to ${colLetters(MAX_COLS - 1)})`}</div>
  );
}

function fileByteInputs(
  text: string | null | undefined,
  mediaToken: string | null | undefined,
  dataB64: string | null | undefined,
): [string | null | undefined, string | null | undefined] {
  if (text != null) return [null, null];
  return [mediaToken, dataB64];
}
function targetRangeIsActive(
  range: CellRect | null,
  targetSheet: number | null,
  activeSheet: number,
): boolean {
  if (!range) return false;
  if (targetSheet == null) return true;
  return targetSheet === activeSheet;
}
function selectedCell(
  active: { r: number; c: number } | null,
  sheet: SheetShape,
): GridCell | null {
  if (!active || !sheet.ws) return null;
  return toGridCell(
    sheet.ws[
      XLSX.utils.encode_cell({ r: active.r, c: active.c })
    ] as XLSX.CellObject,
  );
}
function selectedRef(active: { r: number; c: number } | null): string {
  if (!active) return "";
  return `${colLetters(active.c)}${active.r + 1}`;
}
function selectedEdit(
  active: { r: number; c: number } | null,
  sheet: string,
  ref: string,
  editedAt: (sheet: string, ref: string) => Change | undefined,
): Change | undefined {
  if (!active) return undefined;
  return editedAt(sheet, ref);
}
function workbookHasSheets(workbook: XLSX.WorkBook | null): boolean {
  if (!workbook) return false;
  return workbook.SheetNames.length > 0;
}
function failedWorkbookMessage(failure: string | null): string {
  return failure ?? "Could not parse this spreadsheet.";
}
function sheetTerminal(
  loading: boolean,
  readError: string,
  workbook: XLSX.WorkBook | null,
  failure: string | null,
) {
  if (loading) return <div className="empty-hint">Opening spreadsheet…</div>;
  if (readError) return <div className="empty-hint">{readError}</div>;
  if (!workbookHasSheets(workbook))
    return <div className="empty-hint">{failedWorkbookMessage(failure)}</div>;
  return null;
}
function scrollTarget(range: CellRect | null, scroll: (row: number) => void) {
  if (range) scroll(range.r1);
}

export default function SheetView({
  mediaToken,
  dataB64,
  text,
  target,
  editable,
  onEditCell,
  readOnlyReason,
}: Props) {
  const [byteToken, byteData] = fileByteInputs(text, mediaToken, dataB64);
  const {
    bytes,
    error: readError,
    loading,
  } = useFileBytes(byteToken, byteData);
  const parsed = useWorkbook(text, bytes);
  const workbook = parsed.wb;
  const selection = useSheetSelection(workbook, target);
  const shape = useMemo(
    () => worksheetShape(workbook, selection.name),
    [workbook, selection.name],
  );
  const numCols = Math.min(MAX_COLS, shape.totalCols);
  const gridRef = useRef<HTMLDivElement>(null);
  const virtual = useGridView(gridRef, workbook, selection.name);
  const focus = useGridFocus(gridRef, shape.totalRows, numCols);
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  useEffect(() => setActive(null), [selection.name]);
  const edits = useEdits(selection.name, editable, onEditCell, focus.focusCell);
  const range = useMemo(() => parseA1Range(target?.range), [target?.range]);
  const rangeActive = targetRangeIsActive(
    range,
    selection.targetSheetIdx,
    selection.activeIdx,
  );
  useEffect(() => {
    scrollTarget(range, focus.scrollRowIntoView);
  }, [focus.scrollRowIntoView, range, selection.sheetIdx, workbook]);
  const rows = useMemo(
    () => gridRows(shape, virtual.view.first, virtual.view.count, numCols),
    [numCols, shape, virtual.view],
  );
  const activeCell = useMemo(
    () => selectedCell(active, shape),
    [active, shape],
  );
  const activeRef = selectedRef(active);
  const activeEdit = selectedEdit(
    active,
    selection.name,
    activeRef,
    edits.editedAt,
  );
  const scan = useMemo(() => scanSheet(shape.ws), [shape.ws]);
  const changedHere = edits.edits.filter(
    (change) => change.sheet === selection.name,
  );
  const highlight = (row: number, column: number) =>
    cellHighlight(range, rangeActive, row, column);
  const select = (row: number, column: number) =>
    setActive({ r: row, c: column });
  const startEdit = (
    row: number,
    column: number,
    cell: GridCell,
    changed: Change | undefined,
    typed?: string,
  ) => {
    setActive({ r: row, c: column });
    setEditingValue(edits.setEditing, row, column, cell, changed, typed);
  };
  const update = (value: string) =>
    edits.setEditing((previous) =>
      previous ? { ...previous, value } : previous,
    );
  const cancel = () => {
    const edit = edits.editing;
    edits.setEditing(null);
    if (edit) focus.focusCell(edit.r, edit.c);
  };
  const selectSheet = (index: number) => {
    selection.setSheetIdx(index);
    edits.setEditing(null);
    setActive(null);
    edits.setNotice("");
    if (gridRef.current) gridRef.current.scrollTop = 0;
  };
  const terminal = sheetTerminal(loading, readError, workbook, parsed.failure);
  if (terminal) return terminal;
  const last = Math.min(
    shape.totalRows,
    virtual.view.first + virtual.view.count,
  );
  return (
    <div className="sheet-view">
      <SheetTabs
        workbook={workbook}
        sheetIdx={selection.sheetIdx}
        select={selectSheet}
      />
      <Notice
        editable={editable}
        notice={edits.notice}
        reason={readOnlyReason}
      />
      <EditBanner
        editable={editable}
        edits={edits.edits}
        undo={edits.undoLastEdit}
      />
      <FormulaBar
        active={active}
        activeCell={activeCell}
        activeEdit={activeEdit}
        name={selection.name}
        rows={shape.totalRows}
        cols={shape.totalCols}
      />
      <SheetGrid
        gridRef={gridRef}
        measure={virtual.measure}
        totalRows={shape.totalRows}
        numCols={numCols}
        widths={shape.widths}
        rows={rows}
        first={virtual.view.first}
        padTop={virtual.view.first * ROW_H}
        padBottom={Math.max(0, (shape.totalRows - last) * ROW_H)}
        editable={editable}
        editing={edits.editing}
        name={selection.name}
        changedAt={edits.editedAt}
        highlight={highlight}
        select={select}
        startEdit={startEdit}
        update={update}
        commit={edits.commitEdit}
        cancel={cancel}
        focus={focus.focusCell}
      />
      <SheetNotes
        sheet={shape}
        scan={scan}
        range={rangeActive ? range : null}
        target={target}
        changed={changedHere}
      />
      <ColumnCap totalCols={shape.totalCols} />
    </div>
  );
}

function setEditingValue(
  setEditing: (
    edit: Edit | null | ((previous: Edit | null) => Edit | null),
  ) => void,
  row: number,
  column: number,
  cell: GridCell,
  changed: Change | undefined,
  typed?: string,
) {
  const seed = changed?.after ?? cell.edit;
  setEditing({ r: row, c: column, value: typed ?? seed, seed });
}
