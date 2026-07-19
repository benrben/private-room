import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
// The ESM build of SheetJS 0.20.x ships codepage tables separately; without
// this, legacy .xls files in non-UTF8 codepages decode to garbled text.
import * as cptable from "xlsx/dist/cpexcel.full.mjs";
import { CellRect, parseA1Range } from "./highlight";

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
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(
    null,
  );
  const hlRef = useRef<HTMLTableCellElement>(null);

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

  useEffect(() => {
    hlRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [hl, sheetIdx, workbook]);

  if (!workbook || workbook.SheetNames.length === 0) {
    return <div className="empty-hint">Could not parse this spreadsheet.</div>;
  }
  const activeIdx = Math.min(sheetIdx, workbook.SheetNames.length - 1);
  const name = workbook.SheetNames[activeIdx];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
    header: 1,
    blankrows: false,
  });
  const visible = rows.slice(0, MAX_ROWS);
  // Rectangular grid width so column letters line up over every row.
  const numCols = Math.min(
    MAX_COLS,
    visible.reduce((m, r) => Math.max(m, (r as unknown[]).length), 0),
  );
  // Only decorate when we're on the sheet the highlight refers to.
  const hlActive =
    hl && (targetSheetIdx == null || targetSheetIdx === activeIdx) ? hl : null;
  const inHl = (i: number, j: number) =>
    !!hlActive && i >= hlActive.r1 && i <= hlActive.r2 && j >= hlActive.c1 && j <= hlActive.c2;

  function commitEdit() {
    if (editing && onEditCell) {
      onEditCell(name, `${colLetters(editing.c)}${editing.r + 1}`, editing.value);
    }
    setEditing(null);
  }

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
              }}
            >
              {n}
            </button>
          ))}
        </div>
      )}
      {editable && (
        <div className="viewer-status">
          Editing — click a cell to change it; each change saves into the file
          immediately.
        </div>
      )}
      <div className="sheet-scroll">
        <table>
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
            {visible.map((row, i) => (
              <tr key={i}>
                {/* Sticky 1-based row number; label "1" == data row 0. */}
                <th className="sheet-rowhead">{i + 1}</th>
                {Array.from({ length: numCols }, (_, j) => {
                  const cell = (row as unknown[])[j];
                  const cellRef =
                    hlActive && i === hlActive.r1 && j === hlActive.c1 ? hlRef : undefined;
                  // Right-align cells that read as numbers (currency/percent
                  // symbols tolerated) so columns of figures line up.
                  const raw = String(cell ?? "");
                  const numeric =
                    raw.trim() !== "" &&
                    !Number.isNaN(Number(raw.replace(/[$£€,%\s]/g, "")));
                  const cls =
                    [
                      inHl(i, j) ? "cell-hl" : "",
                      editable ? "cell-editable" : "",
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
                      onChange={(e) => setEditing({ r: i, c: j, value: e.target.value })}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitEdit();
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                  ) : (
                    String(cell ?? "")
                  );
                  const onClick =
                    editable && !isEditing
                      ? () => setEditing({ r: i, c: j, value: String(cell ?? "") })
                      : undefined;
                  return (
                    <td key={j} ref={cellRef} className={cls} onClick={onClick}>
                      {body}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > MAX_ROWS && (
          <div className="viewer-status">
            Showing first {MAX_ROWS.toLocaleString()} of {rows.length.toLocaleString()} rows
          </div>
        )}
      </div>
    </div>
  );
}
