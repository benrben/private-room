import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
// The ESM build of SheetJS 0.20.x ships codepage tables separately; without
// this, legacy .xls files in non-UTF8 codepages decode to garbled text.
import * as cptable from "xlsx/dist/cpexcel.full.mjs";
import { CellRect, parseA1Range } from "./highlight";
import "./sheet.css";

XLSX.set_cptable(cptable);

const MAX_ROWS = 1000;
const MAX_COLS = 60;

export interface SheetTarget {
  sheet?: string;
  range?: string;
}

interface Props {
  dataB64?: string | null;
  text?: string | null;
  target?: SheetTarget;
  /** Edit mode: click a cell to change it; commits per cell. */
  editable?: boolean;
  onEditCell?: (sheet: string, cell: string, value: string) => void;
}

/** One rendered cell. `text` is what the sheet shows; `edit` is what an editor
 * must be seeded with — the FORMULA SOURCE when the cell has one, so opening
 * and closing a formula cell can't silently replace it with its last result. */
interface GridCell {
  text: string;
  edit: string;
  formula: boolean;
}

const EMPTY_CELL: GridCell = { text: "", edit: "", formula: false };

/** 0-based column index → "A", "B", … "AA". */
function colLetters(c: number): string {
  let n = c + 1;
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(64 + ((n - 1) % 26) + 1) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function toGridCell(cell: XLSX.CellObject | undefined): GridCell {
  if (!cell) return EMPTY_CELL;
  const shown = cell.w ?? (cell.v == null ? "" : String(cell.v));
  return {
    text: shown,
    // SheetJS stores the formula without its leading "=".
    edit: cell.f ? `=${cell.f}` : shown,
    formula: !!cell.f,
  };
}

export default function SheetView({ dataB64, text, target, editable, onEditCell }: Props) {
  const workbook = useMemo(() => {
    try {
      if (dataB64) return XLSX.read(dataB64, { type: "base64" });
      return XLSX.read(text ?? "", { type: "string" });
    } catch {
      return null;
    }
  }, [dataB64, text]);
  const [sheetIdx, setSheetIdx] = useState(0);
  /** `seed` is what the cell held when the editor opened, so a commit can tell
   * a real change from a cell that was only clicked into. */
  const [editing, setEditing] = useState<{
    r: number;
    c: number;
    value: string;
    seed: string;
  } | null>(null);
  /** Why the last commit was declined, shown under the grid. */
  const [notice, setNotice] = useState("");
  const hlRef = useRef<HTMLTableCellElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const hl: CellRect | null = useMemo(
    () => parseA1Range(target?.range),
    [target?.range],
  );

  // An agent target selects its sheet and scrolls the range into view.
  const targetSheetIdx = useMemo(() => {
    if (!workbook || !target?.sheet) return null;
    const wanted = target.sheet.toLowerCase();
    const idx = workbook.SheetNames.findIndex((n) => n.toLowerCase() === wanted);
    return idx >= 0 ? idx : null;
  }, [workbook, target?.sheet]);

  useEffect(() => {
    if (targetSheetIdx != null) setSheetIdx(targetSheetIdx);
  }, [targetSheetIdx]);

  const activeIdx = workbook
    ? Math.min(sheetIdx, workbook.SheetNames.length - 1)
    : 0;
  const name = workbook ? workbook.SheetNames[activeIdx] : "";

  /**
   * The visible window, addressed in TRUE A1 coordinates.
   *
   * Read straight off the worksheet rather than through sheet_to_json: that
   * helper drops blank rows and numbers what survives from one, so on a sheet
   * with an empty row — or one whose data doesn't start at A1 — row `i` of the
   * grid was NOT row `i+1` of the file, and typing saved into the wrong cell.
   * Building only the window we draw also means a keystroke in the editor no
   * longer re-parses the whole file (this memo doesn't depend on the edit).
   */
  const grid = useMemo(() => {
    const ws = workbook?.Sheets[name];
    const ref = ws?.["!ref"];
    if (!ws || !ref) return { rows: [] as GridCell[][], totalRows: 0, totalCols: 0 };
    const range = XLSX.utils.decode_range(ref);
    // A1-absolute extents: a sheet starting at B3 still has rows 1-2 / column A,
    // they are simply empty — and the grid must show them so the row numbers
    // and column letters are the file's own.
    const totalRows = Math.max(0, range.e.r + 1);
    const totalCols = Math.max(0, range.e.c + 1);
    const rowCount = Math.min(totalRows, MAX_ROWS);
    const colCount = Math.min(totalCols, MAX_COLS);
    const rows: GridCell[][] = [];
    for (let r = 0; r < rowCount; r++) {
      const row: GridCell[] = [];
      for (let c = 0; c < colCount; c++) {
        row.push(toGridCell(ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject));
      }
      rows.push(row);
    }
    return { rows, totalRows, totalCols };
  }, [workbook, name]);

  useEffect(() => {
    hlRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [hl, sheetIdx, workbook]);

  function focusCell(r: number, c: number) {
    gridRef.current
      ?.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`)
      ?.focus();
  }

  function commitEdit(move?: { dr: number; dc: number }) {
    const at = editing;
    // Blur always commits, so a stray click into a cell and a click anywhere
    // else used to rewrite that cell. Now that the editor is seeded with the
    // FORMULA SOURCE that rewrite was destructive twice over — the file writer
    // stores "=SUM(A1:A5)" as literal text, replacing a number with garbage.
    // Nothing changed means nothing to save; and a value that starts with "="
    // is declined out loud rather than written as text pretending to be a sum.
    if (at && onEditCell && at.value !== at.seed) {
      const ref = `${colLetters(at.c)}${at.r + 1}`;
      if (at.value.trimStart().startsWith("=")) {
        setNotice(
          `${ref} was left unchanged — this editor saves values, not formulas.`,
        );
      } else {
        setNotice("");
        onEditCell(name, ref, at.value);
      }
    }
    setEditing(null);
    // Enter saves and steps on, the way a spreadsheet does — otherwise a
    // keyboard user is stranded on the cell they just typed into.
    if (at && move) {
      requestAnimationFrame(() => focusCell(at.r + move.dr, at.c + move.dc));
    }
  }

  if (!workbook || workbook.SheetNames.length === 0) {
    return <div className="empty-hint">Could not parse this spreadsheet.</div>;
  }
  const { rows, totalRows, totalCols } = grid;
  const numCols = Math.min(MAX_COLS, totalCols);
  // Only decorate when we're on the sheet the highlight refers to.
  const hlActive =
    hl && (targetSheetIdx == null || targetSheetIdx === activeIdx) ? hl : null;
  const inHl = (i: number, j: number) =>
    !!hlActive && i >= hlActive.r1 && i <= hlActive.r2 && j >= hlActive.c1 && j <= hlActive.c2;

  return (
    <div className="sheet-view">
      {workbook.SheetNames.length > 1 && (
        <div className="sheet-tabs">
          {workbook.SheetNames.map((n, i) => (
            <button
              key={n}
              className={i === sheetIdx ? "active" : ""}
              onClick={() => {
                setSheetIdx(i);
                setEditing(null);
                setNotice("");
              }}
            >
              {n}
            </button>
          ))}
        </div>
      )}
      {editable && (
        <div className="viewer-status">
          Editing — click a cell, or move with the arrow keys and press Enter to
          change it; each change saves into the file immediately. Formula cells
          show their source, but only a value can be saved back.
        </div>
      )}
      {editable && notice && (
        <div className="viewer-status sheet-notice" role="status">
          {notice}
        </div>
      )}
      <div className="sheet-scroll" ref={gridRef}>
        <table role="grid" aria-readonly={!editable}>
          <thead>
            <tr>
              {/* Blank corner, then spreadsheet column letters A, B, C … */}
              <th className="sheet-corner" aria-hidden />
              {Array.from({ length: numCols }, (_, j) => (
                <th key={j} className="sheet-colhead">
                  {colLetters(j)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {/* Sticky 1-based row number; label "1" == sheet row 1. */}
                <th className="sheet-rowhead">{i + 1}</th>
                {Array.from({ length: numCols }, (_, j) => {
                  const cell = row[j] ?? EMPTY_CELL;
                  const cellRef =
                    hlActive && i === hlActive.r1 && j === hlActive.c1 ? hlRef : undefined;
                  // Right-align cells that read as numbers (currency/percent
                  // symbols tolerated) so columns of figures line up.
                  const raw = cell.text;
                  const numeric =
                    raw.trim() !== "" &&
                    !Number.isNaN(Number(raw.replace(/[$£€,%\s]/g, "")));
                  const cls =
                    [
                      inHl(i, j) ? "cell-hl" : "",
                      editable ? "cell-editable" : "",
                      cell.formula ? "cell-formula" : "",
                      numeric ? "num" : "",
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined;
                  const isEditing =
                    !!editable && !!editing && editing.r === i && editing.c === j;
                  const body = isEditing ? (
                    <input
                      className="cell-input"
                      autoFocus
                      value={editing.value}
                      aria-label={`${colLetters(j)}${i + 1}`}
                      onChange={(e) =>
                        setEditing((prev) =>
                          prev ? { ...prev, value: e.target.value } : prev,
                        )
                      }
                      onBlur={() => commitEdit()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitEdit({ dr: 1, dc: 0 });
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setEditing(null);
                          requestAnimationFrame(() => focusCell(i, j));
                        }
                      }}
                    />
                  ) : (
                    cell.text
                  );
                  // `typed` is the character that opened the editor (Excel's
                  // type-to-replace); `seed` stays the cell's own content so
                  // that counts as a change and a bare click does not.
                  const startEdit = (typed?: string) =>
                    setEditing({
                      r: i,
                      c: j,
                      value: typed ?? cell.edit,
                      seed: cell.edit,
                    });
                  return (
                    <td
                      key={j}
                      ref={cellRef}
                      className={cls}
                      role="gridcell"
                      data-r={i}
                      data-c={j}
                      // Editable cells are reachable with Tab and the arrow
                      // keys; a mouse must not be the only way in.
                      tabIndex={editable && !isEditing ? 0 : -1}
                      title={
                        cell.formula
                          ? `Formula: ${cell.edit} — saving a value here replaces the formula with that value.`
                          : undefined
                      }
                      onClick={editable && !isEditing ? () => startEdit() : undefined}
                      onKeyDown={
                        editable && !isEditing
                          ? (e) => {
                              if (e.key === "Enter" || e.key === "F2") {
                                e.preventDefault();
                                startEdit();
                              } else if (e.key === "ArrowDown") {
                                e.preventDefault();
                                focusCell(i + 1, j);
                              } else if (e.key === "ArrowUp") {
                                e.preventDefault();
                                focusCell(i - 1, j);
                              } else if (e.key === "ArrowRight") {
                                e.preventDefault();
                                focusCell(i, j + 1);
                              } else if (e.key === "ArrowLeft") {
                                e.preventDefault();
                                focusCell(i, j - 1);
                              } else if (
                                e.key.length === 1 &&
                                !e.metaKey &&
                                !e.ctrlKey &&
                                !e.altKey
                              ) {
                                // Typing over a cell replaces it, as in Excel.
                                e.preventDefault();
                                startEdit(e.key);
                              }
                            }
                          : undefined
                      }
                    >
                      {body}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {/* Trimming must always be visible — a wide report silently stopping at
            column BH reads as "those columns aren't in the file". */}
        {(totalRows > MAX_ROWS || totalCols > MAX_COLS) && (
          <div className="viewer-status">
            {totalRows > MAX_ROWS &&
              `Showing first ${MAX_ROWS.toLocaleString()} of ${totalRows.toLocaleString()} rows`}
            {totalRows > MAX_ROWS && totalCols > MAX_COLS && " · "}
            {totalCols > MAX_COLS &&
              `Showing first ${MAX_COLS} of ${totalCols.toLocaleString()} columns (up to ${colLetters(
                MAX_COLS - 1,
              )})`}
          </div>
        )}
      </div>
    </div>
  );
}
