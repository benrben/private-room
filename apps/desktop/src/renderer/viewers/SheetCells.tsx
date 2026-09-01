import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type * as XLSX from "xlsx";
import { colLetters } from "./csvquoting";
import {
  cellClasses,
  handleCellKey,
  handleInputKey,
  numericText,
  usedRange,
} from "./sheetEdits";
import type { Change, Edit, GridCell } from "./sheetModel";

const ROW_H = 24;

export function SheetTabs({
  workbook,
  sheetIdx,
  select,
}: {
  workbook: XLSX.WorkBook | null;
  sheetIdx: number;
  select: (index: number) => void;
}) {
  if (!workbook) return null;
  if (workbook.SheetNames.length < 2) return null;
  return (
    <div className="sheet-tabs">
      {workbook.SheetNames.map((name, index) => (
        <button
          key={name}
          type="button"
          className={index === sheetIdx ? "active" : ""}
          aria-current={index === sheetIdx ? "true" : undefined}
          onClick={() => select(index)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
export function EditBanner({
  editable,
  edits,
  undo,
}: {
  editable: boolean | undefined;
  edits: Change[];
  undo: () => void;
}) {
  if (!editable) return null;
  return (
    <div className="viewer-status sheet-editbar">
      <span>
        Editing — click a cell, or move with the arrow keys and press Enter to
        change it; each change saves into the file immediately. Formula cells
        show their source, but only a value can be saved back.
      </span>
      <ChangedCells edits={edits} undo={undo} />
    </div>
  );
}
export function ChangedCells({ edits, undo }: { edits: Change[]; undo: () => void }) {
  const last = edits[edits.length - 1];
  if (!last) return null;
  return (
    <span className="sheet-edits">
      <strong>
        {edits.length} cell{edits.length === 1 ? "" : "s"} changed
      </strong>
      <button className="nb-btn" onClick={undo}>
        Undo {last.ref} ⌘Z
      </button>
    </span>
  );
}
export function Notice({
  editable,
  notice,
  reason,
}: {
  editable: boolean | undefined;
  notice: string;
  reason?: string;
}) {
  return (
    <>
      {reason && (
        <div className="viewer-status sheet-readonly" role="status">
          {reason}
        </div>
      )}
      {editable && notice && (
        <div className="viewer-status sheet-notice" role="status">
          {notice}
        </div>
      )}
    </>
  );
}
export function formulaBarRef(
  active: { r: number; c: number } | null,
  rows: number,
  cols: number,
) {
  return active
    ? `${colLetters(active.c)}${active.r + 1}`
    : usedRange(rows, cols);
}
export function formulaBarValue(
  active: { r: number; c: number } | null,
  activeCell: GridCell | null,
  activeEdit: Change | undefined,
  name: string,
  rows: number,
  cols: number,
) {
  if (!active)
    return `${name} — ${rows.toLocaleString()} rows × ${cols.toLocaleString()} columns`;
  const value = activeEdit ? activeEdit.after : (activeCell?.edit ?? "");
  return value || "(empty)";
}
export function formulaBarLabel(
  active: { r: number; c: number } | null,
  formula: boolean,
) {
  if (!active) return "Sheet";
  return formula ? "Formula" : "Value";
}
export function FormulaBar({
  active,
  activeCell,
  activeEdit,
  name,
  rows,
  cols,
}: {
  active: { r: number; c: number } | null;
  activeCell: GridCell | null;
  activeEdit: Change | undefined;
  name: string;
  rows: number;
  cols: number;
}) {
  const ref = formulaBarRef(active, rows, cols);
  const formula = Boolean(activeCell?.formula && !activeEdit);
  const value = formulaBarValue(
    active,
    activeCell,
    activeEdit,
    name,
    rows,
    cols,
  );
  return (
    <div className="sheet-bar">
      <span className="sheet-ref">{ref}</span>
      <span className={`sheet-field-key${formula ? " is-formula" : ""}`}>
        {formulaBarLabel(active, formula)}
      </span>
      <span className="sheet-src">{value}</span>
    </div>
  );
}

export function CellInput({
  edit,
  update,
  commit,
  cancel,
}: {
  edit: Edit;
  update: (value: string) => void;
  commit: (move?: { dr: number; dc: number }) => void;
  cancel: () => void;
}) {
  return (
    <input
      className="cell-input"
      autoFocus
      value={edit.value}
      aria-label={`${colLetters(edit.c)}${edit.r + 1}`}
      onChange={(event) => update(event.target.value)}
      onBlur={() => commit()}
      onKeyDown={(event) => handleInputKey(event, commit, cancel)}
    />
  );
}
export function isEditingCell(
  editable: boolean | undefined,
  editing: Edit | null,
  row: number,
  column: number,
): boolean {
  if (!editable || !editing) return false;
  return editing.r === row && editing.c === column;
}
export function cellClick(
  editable: boolean | undefined,
  isEditing: boolean,
  start: () => void,
  select: () => void,
) {
  if (editable && !isEditing) return start;
  return select;
}
export function cellFocus(
  editable: boolean | undefined,
  isEditing: boolean,
  select: () => void,
) {
  if (!editable || isEditing) return undefined;
  return select;
}
export function cellKeyDown(
  editable: boolean | undefined,
  isEditing: boolean,
  start: (typed?: string) => void,
  focus: (row: number, column: number) => void,
  row: number,
  column: number,
) {
  if (!editable || isEditing) return undefined;
  return (event: ReactKeyboardEvent) =>
    handleCellKey(event, start, focus, row, column);
}
export function cellTitle(cell: GridCell): string | undefined {
  if (!cell.formula) return undefined;
  return `Formula: ${cell.edit} — saving a value here replaces the formula with that value.`;
}
export function cellColSpan(cell: GridCell): number | undefined {
  return cell.span > 1 ? cell.span : undefined;
}
export function cellTabIndex(
  editable: boolean | undefined,
  isEditing: boolean,
): number {
  return editable && !isEditing ? 0 : -1;
}
export function CellContents({
  isEditing,
  editing,
  raw,
  update,
  commit,
  cancel,
}: {
  isEditing: boolean;
  editing: Edit | null;
  raw: string;
  update: (value: string) => void;
  commit: (move?: { dr: number; dc: number }) => void;
  cancel: () => void;
}) {
  if (!isEditing || !editing) return raw;
  return (
    <CellInput edit={editing} update={update} commit={commit} cancel={cancel} />
  );
}
export function SheetCell({
  cell,
  row,
  column,
  editable,
  editing,
  changed,
  highlighted,
  select,
  start,
  update,
  commit,
  cancel,
  focus,
}: {
  cell: GridCell;
  row: number;
  column: number;
  editable: boolean | undefined;
  editing: Edit | null;
  changed: Change | undefined;
  highlighted: boolean;
  select: () => void;
  start: (typed?: string) => void;
  update: (value: string) => void;
  commit: (move?: { dr: number; dc: number }) => void;
  cancel: () => void;
  focus: (row: number, column: number) => void;
}) {
  if (cell.covered) return null;
  const isEditing = isEditingCell(editable, editing, row, column);
  const raw = changed ? changed.after : cell.text;
  const cls = cellClasses(
    highlighted,
    Boolean(editable),
    Boolean(changed),
    cell.formula,
    numericText(raw),
    Boolean(cell.style?.textAlign),
  );
  const click = cellClick(editable, isEditing, () => start(), select);
  const keyDown = cellKeyDown(editable, isEditing, start, focus, row, column);
  const onFocus = cellFocus(editable, isEditing, select);
  return (
    <td
      key={column}
      className={cls}
      style={cell.style}
      colSpan={cellColSpan(cell)}
      role="gridcell"
      data-r={row}
      data-c={column}
      tabIndex={cellTabIndex(editable, isEditing)}
      title={cellTitle(cell)}
      onFocus={onFocus}
      onClick={click}
      onKeyDown={keyDown}
    >
      <CellContents
        isEditing={isEditing}
        editing={editing}
        raw={raw}
        update={update}
        commit={commit}
        cancel={cancel}
      />
    </td>
  );
}
export function GridRows({
  rows,
  first,
  editable,
  editing,
  name,
  changedAt,
  highlight,
  select,
  startEdit,
  update,
  commit,
  cancel,
  focus,
}: {
  rows: GridCell[][];
  first: number;
  editable: boolean | undefined;
  editing: Edit | null;
  name: string;
  changedAt: (sheet: string, ref: string) => Change | undefined;
  highlight: (row: number, column: number) => boolean;
  select: (row: number, column: number) => void;
  startEdit: (
    row: number,
    column: number,
    cell: GridCell,
    changed: Change | undefined,
    typed?: string,
  ) => void;
  update: (value: string) => void;
  commit: (move?: { dr: number; dc: number }) => void;
  cancel: () => void;
  focus: (row: number, column: number) => void;
}) {
  return (
    <>
      {rows.map((values, relativeRow) => {
        const row = first + relativeRow;
        return (
          <tr key={row} style={{ height: ROW_H }} aria-rowindex={row + 1}>
            <th className="sheet-rowhead">{row + 1}</th>
            {values.map((cell, column) => {
              const changed = editable
                ? changedAt(name, `${colLetters(column)}${row + 1}`)
                : undefined;
              const selectCell = () => select(row, column);
              const start = (typed?: string) =>
                startEdit(row, column, cell, changed, typed);
              return (
                <SheetCell
                  key={column}
                  cell={cell}
                  row={row}
                  column={column}
                  editable={editable}
                  editing={editing}
                  changed={changed}
                  highlighted={highlight(row, column)}
                  select={selectCell}
                  start={start}
                  update={update}
                  commit={commit}
                  cancel={cancel}
                  focus={focus}
                />
              );
            })}
          </tr>
        );
      })}
    </>
  );
}
export function Spacer({ height, cols }: { height: number; cols: number }) {
  if (height <= 0) return null;
  return (
    <tr aria-hidden style={{ height }}>
      <td colSpan={cols + 1} />
    </tr>
  );
}
