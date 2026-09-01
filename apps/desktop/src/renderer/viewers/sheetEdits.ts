import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import type * as XLSX from "xlsx";
import type { CellRect } from "./highlight";
import { colLetters } from "./csvquoting";
import {
  activeSheetIndex,
  sheetIndexFor,
  type Change,
  type Edit,
  type Props,
  type SheetTarget,
} from "./sheetModel";

const ROW_H = 24;
const OVERSCAN = 12;

export function useSheetSelection(
  workbook: XLSX.WorkBook | null,
  target: SheetTarget | undefined,
) {
  const [sheetIdx, setSheetIdx] = useState(0);
  const targetSheetIdx = useMemo(
    () => sheetIndexFor(workbook, target?.sheet),
    [workbook, target?.sheet],
  );
  useEffect(() => {
    if (targetSheetIdx != null) setSheetIdx(targetSheetIdx);
  }, [targetSheetIdx]);
  const activeIdx = activeSheetIndex(workbook, sheetIdx);
  const name = workbook ? workbook.SheetNames[activeIdx] : "";
  return { activeIdx, name, setSheetIdx, sheetIdx, targetSheetIdx };
}
export function useGridView(
  gridRef: RefObject<HTMLDivElement | null>,
  workbook: XLSX.WorkBook | null,
  name: string,
) {
  const [view, setView] = useState({ first: 0, count: 60 });
  const measure = useCallback(() => {
    const element = gridRef.current;
    if (!element) return;
    const scrollTop = Number(element.scrollTop) || 0;
    const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const height = element.clientHeight || ROW_H;
    const count = Math.ceil(height / ROW_H) + OVERSCAN * 2;
    setView((previous) =>
      previous.first === first && previous.count === count
        ? previous
        : { first, count },
    );
  }, [gridRef]);
  useLayoutEffect(() => {
    measure();
    const element = gridRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [gridRef, measure, workbook, name]);
  return { measure, view };
}
export function useGridFocus(
  gridRef: RefObject<HTMLDivElement | null>,
  totalRows: number,
  numCols: number,
) {
  const scrollRowIntoView = useCallback(
    (row: number, after?: () => void) => {
      const element = gridRef.current;
      if (!element) return;
      const top = row * ROW_H;
      const bottom = element.scrollTop + element.clientHeight - ROW_H * 2;
      if (top < element.scrollTop || top > bottom)
        element.scrollTop = Math.max(0, top - element.clientHeight / 2);
      if (after) requestAnimationFrame(() => requestAnimationFrame(after));
    },
    [gridRef],
  );
  const focusCell = useCallback(
    (row: number, column: number) => {
      if (row < 0 || column < 0 || row >= totalRows || column >= numCols)
        return;
      scrollRowIntoView(row, () =>
        gridRef.current
          ?.querySelector<HTMLTableCellElement>(
            `td[data-r="${row}"][data-c="${column}"]`,
          )
          ?.focus(),
      );
    },
    [gridRef, numCols, scrollRowIntoView, totalRows],
  );
  return { focusCell, scrollRowIntoView };
}

export function editKey(sheet: string, ref: string): string {
  return `${sheet}!${ref}`;
}
export function recordChange(
  previous: Change[],
  sheet: string,
  ref: string,
  before: string,
  after: string,
): Change[] {
  const key = editKey(sheet, ref);
  const seen = previous.find((change) => change.key === key);
  const rest = previous.filter((change) => change.key !== key);
  if ((seen?.before ?? before) === after) return rest;
  return [...rest, { key, sheet, ref, before: seen?.before ?? before, after }];
}
export function isUndoKey(event: globalThis.KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (event.key !== "z") return false;
  return !event.shiftKey;
}
export function cellRef(edit: Edit): string {
  return `${colLetters(edit.c)}${edit.r + 1}`;
}
export function isFormulaValue(value: string): boolean {
  return value.trimStart().startsWith("=");
}
export function useEdits(
  name: string,
  editable: boolean | undefined,
  onEditCell: Props["onEditCell"],
  focusCell: (row: number, column: number) => void,
) {
  const [editing, setEditing] = useState<Edit | null>(null);
  const [notice, setNotice] = useState("");
  const [edits, setEdits] = useState<Change[]>([]);
  const editedAt = useCallback(
    (sheet: string, ref: string) =>
      edits.find((change) => change.key === editKey(sheet, ref)),
    [edits],
  );
  const undoLastEdit = useCallback(() => {
    const last = edits[edits.length - 1];
    if (!last) return;
    onEditCell?.(last.sheet, last.ref, last.before);
    setNotice(`${last.ref} put back to "${last.before || "(empty)"}".`);
    setEdits((previous) => previous.slice(0, -1));
  }, [edits, onEditCell]);
  useEffect(() => {
    if (!editable) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!isUndoKey(event)) return;
      if (editing) return;
      event.preventDefault();
      undoLastEdit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, editing, undoLastEdit]);
  const commitDraft = (edit: Edit) => {
    if (!onEditCell || edit.value === edit.seed) return;
    const ref = cellRef(edit);
    if (isFormulaValue(edit.value)) {
      setNotice(
        `${ref} was left unchanged — this editor saves values, not formulas.`,
      );
      return;
    }
    setNotice("");
    onEditCell(name, ref, edit.value);
    setEdits((previous) =>
      recordChange(previous, name, ref, edit.seed, edit.value),
    );
  };
  const commitEdit = (move?: { dr: number; dc: number }) => {
    const edit = editing;
    if (edit) commitDraft(edit);
    setEditing(null);
    if (edit && move) focusCell(edit.r + move.dr, edit.c + move.dc);
  };
  return {
    commitEdit,
    editedAt,
    editing,
    edits,
    notice,
    setEditing,
    setNotice,
    undoLastEdit,
  };
}

export function usedRange(rows: number, cols: number): string {
  if (rows > 0 && cols > 0) return `A1:${colLetters(cols - 1)}${rows}`;
  return "—";
}
export function cellHighlight(
  range: CellRect | null,
  active: boolean,
  row: number,
  column: number,
): boolean {
  if (!range) return false;
  if (!active) return false;
  if (outsideRange(row, range.r1, range.r2)) return false;
  if (outsideRange(column, range.c1, range.c2)) return false;
  return true;
}
export function outsideRange(value: number, first: number, last: number): boolean {
  return value < first || value > last;
}
export function numericText(value: string): boolean {
  if (value.trim() === "") return false;
  return !Number.isNaN(Number(value.replace(/[$£€,%\s]/g, "")));
}
export function classPart(enabled: boolean, name: string): string {
  return enabled ? name : "";
}
export function cellClasses(
  highlighted: boolean,
  editable: boolean,
  changed: boolean,
  formula: boolean,
  numeric: boolean,
  aligned: boolean,
) {
  return (
    [
      classPart(highlighted, "cell-hl"),
      classPart(editable, "cell-editable"),
      classPart(changed, "cell-changed"),
      classPart(formula, "cell-formula"),
      classPart(numeric && !aligned, "num"),
    ]
      .filter(Boolean)
      .join(" ") || undefined
  );
}
export function typedKey(event: ReactKeyboardEvent): string | undefined {
  if (event.key.length !== 1) return undefined;
  if (event.metaKey) return undefined;
  if (event.ctrlKey) return undefined;
  if (event.altKey) return undefined;
  return event.key;
}
export const ARROW_MOVES: Record<string, { dr: number; dc: number } | undefined> = {
  ArrowDown: { dr: 1, dc: 0 },
  ArrowUp: { dr: -1, dc: 0 },
  ArrowRight: { dr: 0, dc: 1 },
  ArrowLeft: { dr: 0, dc: -1 },
};
export function handleCellKey(
  event: ReactKeyboardEvent,
  start: (typed?: string) => void,
  focus: (row: number, column: number) => void,
  row: number,
  column: number,
) {
  if (event.key === "Enter" || event.key === "F2") {
    event.preventDefault();
    start();
    return;
  }
  const move = ARROW_MOVES[event.key];
  if (move) {
    event.preventDefault();
    focus(row + move.dr, column + move.dc);
    return;
  }
  const typed = typedKey(event);
  if (typed) {
    event.preventDefault();
    start(typed);
  }
}
export function handleInputKey(
  event: ReactKeyboardEvent,
  commit: (move?: { dr: number; dc: number }) => void,
  cancel: () => void,
) {
  if (event.key === "Enter") {
    event.preventDefault();
    commit({ dr: 1, dc: 0 });
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    cancel();
  }
}
