import type { RefObject } from "react";
import type { CellRect } from "./highlight";
import { colLetters } from "./csvquoting";
import { usedRange } from "./sheetEdits";
import { GridRows, Spacer } from "./SheetCells";
import {
  DEFAULT_COL_W,
  scanSheet,
  type Change,
  type Edit,
  type GridCell,
  type SheetShape,
  type SheetTarget,
} from "./sheetModel";

export function SheetGrid({
  gridRef,
  measure,
  totalRows,
  numCols,
  widths,
  rows,
  first,
  padTop,
  padBottom,
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
  gridRef: RefObject<HTMLDivElement | null>;
  measure: () => void;
  totalRows: number;
  numCols: number;
  widths: number[];
  rows: GridCell[][];
  first: number;
  padTop: number;
  padBottom: number;
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
    <div className="sheet-scroll" ref={gridRef} onScroll={measure}>
      <table role="grid" aria-readonly={!editable} aria-rowcount={totalRows}>
        <colgroup>
          <col className="sheet-corner-col" />
          {Array.from({ length: numCols }, (_, column) => (
            <col
              key={column}
              style={{ width: widths[column] ?? DEFAULT_COL_W }}
            />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="sheet-corner" aria-hidden />
            {Array.from({ length: numCols }, (_, column) => (
              <th key={column} className="sheet-colhead">
                {colLetters(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <Spacer height={padTop} cols={numCols} />
          <GridRows
            rows={rows}
            first={first}
            editable={editable}
            editing={editing}
            name={name}
            changedAt={changedAt}
            highlight={highlight}
            select={select}
            startEdit={startEdit}
            update={update}
            commit={commit}
            cancel={cancel}
            focus={focus}
          />
          <Spacer height={padBottom} cols={numCols} />
        </tbody>
      </table>
    </div>
  );
}
export function FormulaNotes({ scan }: { scan: ReturnType<typeof scanSheet> }) {
  if (!scan.scanned)
    return (
      <>
        This sheet holds too many cells to count one by one, so no total is
        given here rather than a guess. Individual formula cells are still
        marked in their top-right corner.
      </>
    );
  if (scan.formulas === 0)
    return (
      <>
        None. All <code>{scan.cells.toLocaleString()}</code> filled cells hold
        values that were typed or pasted in.
      </>
    );
  return (
    <>
      <code>{scan.formulas.toLocaleString()}</code> of{" "}
      <code>{scan.cells.toLocaleString()}</code> filled cells are computed. Each
      is marked in its top-right corner, and selecting one shows its source in
      the bar above the grid — the grid itself can only ever show the result.
    </>
  );
}
export function notesGlance(
  sheet: SheetShape,
  scan: ReturnType<typeof scanSheet>,
  changed: Change[],
): string {
  const parts = [
    `${sheet.totalRows.toLocaleString()} rows`,
    `${sheet.totalCols.toLocaleString()} columns`,
  ];
  if (scan.scanned) parts.push(`${scan.formulas.toLocaleString()} formulas`);
  if (changed.length) parts.push(`${changed.length} changed`);
  return parts.join(" · ");
}
export function MergedNote({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="sheet-note">
      <dt>Merged</dt>
      <dd>
        <code>{count.toLocaleString()}</code> merges run across columns and are
        drawn as one wide cell.
      </dd>
    </div>
  );
}
export function HiddenNote({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="sheet-note">
      <dt>Hidden</dt>
      <dd>
        <code>{count.toLocaleString()}</code> shown columns are hidden in the
        file and are drawn at zero width.
      </dd>
    </div>
  );
}
export function PointedNote({
  range,
  target,
}: {
  range: CellRect | null;
  target?: SheetTarget;
}) {
  if (!range || !target?.range) return null;
  return (
    <div className="sheet-note">
      <dt>Pointed at</dt>
      <dd>
        The assistant pointed at <code>{target.range}</code> on this sheet.
      </dd>
    </div>
  );
}
export function ChangedNote({ changed }: { changed: Change[] }) {
  if (changed.length === 0) return null;
  return (
    <div className="sheet-note">
      <dt>Changed here</dt>
      <dd>
        <code>{changed.map((change) => change.ref).join(", ")}</code> — changed
        in this session and already saved into the file.
      </dd>
    </div>
  );
}
export function SheetNotes({
  sheet,
  scan,
  range,
  target,
  changed,
}: {
  sheet: SheetShape;
  scan: ReturnType<typeof scanSheet>;
  range: CellRect | null;
  target?: SheetTarget;
  changed: Change[];
}) {
  const hidden = sheet.widths.filter((width) => width === 0).length;
  const merged = sheet.merges.size;
  return (
    <details className="sheet-notes">
      <summary>
        <span className="sheet-notes-caret" aria-hidden>
          ▸
        </span>
        <span className="sheet-notes-label">Notes</span>
        <span className="sheet-notes-glance">
          {notesGlance(sheet, scan, changed)}
        </span>
      </summary>
      <dl className="sheet-notes-fields">
        <div className="sheet-note">
          <dt>Grid</dt>
          <dd>
            <code>{sheet.totalRows.toLocaleString()}</code> rows by{" "}
            <code>{sheet.totalCols.toLocaleString()}</code> columns —{" "}
            <code>{usedRange(sheet.totalRows, sheet.totalCols)}</code>. Rows and
            columns are numbered exactly as the file numbers them.
          </dd>
        </div>
        <div className="sheet-note">
          <dt>Formulas</dt>
          <dd>
            <FormulaNotes scan={scan} />
          </dd>
        </div>
        <MergedNote count={merged} />
        <HiddenNote count={hidden} />
        <PointedNote range={range} target={target} />
        <ChangedNote changed={changed} />
        {changed.length > 0 && (
          <div className="sheet-note">
            <dt>Changed here</dt>
            <dd>
              <code>{changed.map((change) => change.ref).join(", ")}</code> —
              changed in this session and already saved into the file.
            </dd>
          </div>
        )}
      </dl>
    </details>
  );
}
