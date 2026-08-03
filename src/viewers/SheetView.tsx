import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
// The ESM build of SheetJS 0.20.x ships codepage tables separately; without
// this, legacy .xls files in non-UTF8 codepages decode to garbled text.
import * as cptable from "xlsx/dist/cpexcel.full.mjs";
import { CellRect, parseA1Range } from "./highlight";
import { colLetters, stripQuotedCsvFormulas } from "./csvquoting";
import { useFileBytes } from "./useFileBytes";
import "./sheet.css";

XLSX.set_cptable(cptable);

/**
 * Rendered row height, in CSS px. Rows are drawn at a uniform height so the
 * virtual window's arithmetic (which row is at this scroll offset?) is exact.
 * A sheet's own row heights are deliberately NOT applied for that reason —
 * variable heights and O(1) scroll math can't both be true, and being able to
 * reach row 90,000 matters more than reproducing a 21.5pt header row.
 */
const ROW_H = 24;
/** Rows drawn above and below the viewport so a fast scroll doesn't flash. */
const OVERSCAN = 12;
/** Default column width when the file doesn't specify one. */
const DEFAULT_COL_W = 96;
/**
 * Ceiling on rendered COLUMNS. Rows virtualize, so their old 1,000-row cap is
 * gone entirely; columns are laid out by the table itself and 16,384 of them
 * would be a real DOM. Any trimming is announced under the grid — the previous
 * caps (1,000 rows / 60 columns) were the reason a 5,000-row export looked
 * like it ended at row 1,000.
 */
const MAX_COLS = 512;

export interface SheetTarget {
  sheet?: string;
  range?: string;
}

interface Props {
  /** Streaming token for the workbook's bytes (roommedia://). */
  mediaToken?: string | null;
  /** Legacy base64 payload — honoured if byte delivery is ever switched back. */
  dataB64?: string | null;
  /** CSV/TSV arrive as raw text rather than as workbook bytes. */
  text?: string | null;
  target?: SheetTarget;
  /** Edit mode: click a cell to change it; commits per cell. */
  editable?: boolean;
  onEditCell?: (sheet: string, cell: string, value: string) => void;
  /** Why this workbook can't be edited, when it can't. Shown above the grid.
   * A legacy `.xls` simply had no Edit button and no explanation, so the only
   * way to learn it was read-only was to look for a control that wasn't there
   * and conclude the app was broken — which is what live QA did. */
  readOnlyReason?: string;
}

/** One rendered cell. `text` is what the sheet shows; `edit` is what an editor
 * must be seeded with — the FORMULA SOURCE when the cell has one, so opening
 * and closing a formula cell can't silently replace it with its last result. */
interface GridCell {
  text: string;
  edit: string;
  formula: boolean;
  /** Inline style carried over from the workbook (fill, font, alignment). */
  style?: React.CSSProperties;
  /** Horizontal merge width, in columns. 1 unless this cell starts a merge. */
  span: number;
  /** True when an earlier cell's horizontal merge already covers this one. */
  covered: boolean;
}

const EMPTY_CELL: GridCell = { text: "", edit: "", formula: false, span: 1, covered: false };

/** `#RRGGBB` from SheetJS's colour shapes, or undefined when it can't be read.
 * The community build fills these in only sometimes, so every read is
 * defensive: a missing colour means "inherit the theme", never a crash. */
function color(c: unknown): string | undefined {
  if (!c || typeof c !== "object") return undefined;
  const rgb = (c as { rgb?: unknown }).rgb;
  if (typeof rgb !== "string" || !/^[0-9a-fA-F]{6,8}$/.test(rgb)) return undefined;
  // Excel writes AARRGGBB; the leading pair is alpha.
  return `#${rgb.length === 8 ? rgb.slice(2) : rgb}`;
}

/** Translate a workbook cell's style into CSS. Everything here is optional —
 * SheetJS's community build reports styles unevenly across files, so each
 * property is applied only when it is actually present. Before this the grid
 * threw ALL of it away: a colour-coded budget rendered as undifferentiated
 * grey text, and a bold header row looked like data. */
function cellStyle(cell: XLSX.CellObject | undefined): React.CSSProperties | undefined {
  const s = (cell as unknown as { s?: Record<string, unknown> } | undefined)?.s;
  if (!s || typeof s !== "object") return undefined;
  const out: React.CSSProperties = {};
  const font = s.font as Record<string, unknown> | undefined;
  if (font) {
    if (font.bold) out.fontWeight = 600;
    if (font.italic) out.fontStyle = "italic";
    if (font.underline) out.textDecoration = "underline";
    const fg = color(font.color);
    if (fg) out.color = fg;
    if (typeof font.sz === "number" && font.sz > 0) out.fontSize = `${font.sz}px`;
  }
  const fill = s.fill as Record<string, unknown> | undefined;
  // patternType "none" means no fill at all — applying fgColor then would
  // paint cells that Excel leaves transparent.
  if (fill && fill.patternType !== "none") {
    const bg = color(fill.fgColor) ?? color(fill.bgColor);
    if (bg) out.background = bg;
  }
  const align = s.alignment as Record<string, unknown> | undefined;
  if (align) {
    const h = align.horizontal;
    if (h === "left" || h === "right" || h === "center") out.textAlign = h;
    if (align.wrapText) out.whiteSpace = "normal";
  }
  return Object.keys(out).length ? out : undefined;
}

function toGridCell(cell: XLSX.CellObject | undefined): GridCell {
  if (!cell) return EMPTY_CELL;
  const shown = cell.w ?? (cell.v == null ? "" : String(cell.v));
  return {
    text: shown,
    // SheetJS stores the formula without its leading "=".
    edit: cell.f ? `=${cell.f}` : shown,
    formula: !!cell.f,
    style: cellStyle(cell),
    span: 1,
    covered: false,
  };
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
  const { bytes, error: readError, loading } = useFileBytes(
    // CSV/TSV never stream — their text IS the file.
    text != null ? null : mediaToken,
    text != null ? null : dataB64,
  );

  const workbook = useMemo(() => {
    try {
      if (text != null) {
        const wb = XLSX.read(text, { type: "string" });
        // SheetJS unquotes a field before deciding what it is, so a quoted
        // `"=SUM(A1:A2)"` — literal text by RFC 4180 — arrives marked as a
        // formula. Put the source's own quoting back over the result.
        for (const n of wb.SheetNames) stripQuotedCsvFormulas(wb.Sheets[n], text);
        return wb;
      }
      if (!bytes) return null;
      // `cellStyles` is what makes column widths, merges and cell formatting
      // reach the grid at all; SheetJS parses them but does not populate them
      // unless asked. `cellDates` stops a date column rendering as 45678.
      return XLSX.read(bytes, { type: "array", cellStyles: true, cellDates: true });
    } catch {
      return null;
    }
  }, [bytes, text]);

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
  const gridRef = useRef<HTMLDivElement>(null);

  /**
   * Cells changed in this session, newest last, keyed `sheet!A1`.
   *
   * A grid edit commits to the FILE the instant you leave the cell, and until
   * now that was the whole story: nothing marked which cells you had touched,
   * ⌘Z did nothing, and the only route back was History → Compare → Restore.
   * Live QA changed one name to `DulceQA_TMP` and had to go through the version
   * history to get it back.
   *
   * `before` is kept from the FIRST edit of a cell, so undoing twice-edited
   * cells lands on what the file actually held, not on an intermediate value.
   */
  const [edits, setEdits] = useState<
    { key: string; sheet: string; ref: string; before: string; after: string }[]
  >([]);

  /** The virtual window: which absolute rows are currently in the DOM. */
  const [view, setView] = useState({ first: 0, count: 60 });

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
   * The sheet's shape and layout, in TRUE A1 coordinates.
   *
   * Read straight off the worksheet rather than through sheet_to_json: that
   * helper drops blank rows and numbers what survives from one, so on a sheet
   * with an empty row — or one whose data doesn't start at A1 — row `i` of the
   * grid was NOT row `i+1` of the file, and typing saved into the wrong cell.
   */
  const sheet = useMemo(() => {
    const ws = workbook?.Sheets[name];
    const ref = ws?.["!ref"];
    if (!ws || !ref) {
      return { ws: null, totalRows: 0, totalCols: 0, widths: [] as number[], merges: new Map() };
    }
    const range = XLSX.utils.decode_range(ref);
    // A1-absolute extents: a sheet starting at B3 still has rows 1-2 / column A,
    // they are simply empty — and the grid must show them so the row numbers
    // and column letters are the file's own.
    const totalRows = Math.max(0, range.e.r + 1);
    const totalCols = Math.max(0, range.e.c + 1);
    const cols = (ws["!cols"] ?? []) as Array<{ wpx?: number; wch?: number; hidden?: boolean }>;
    const widths: number[] = [];
    for (let c = 0; c < Math.min(totalCols, MAX_COLS); c++) {
      const spec = cols[c];
      if (spec?.hidden) widths.push(0);
      else if (typeof spec?.wpx === "number") widths.push(Math.round(spec.wpx));
      // `wch` is a character count; Excel's own approximation is ~7px/char + padding.
      else if (typeof spec?.wch === "number") widths.push(Math.round(spec.wch * 7 + 10));
      else widths.push(DEFAULT_COL_W);
    }
    // HORIZONTAL merges only, keyed by their starting cell.
    //
    // A vertical merge would need a rowSpan reaching outside the virtual
    // window, which cannot be expressed without breaking the table's layout
    // the moment its top row scrolls away. The covered cells are empty in the
    // file regardless, so a vertical merge simply shows its value in its top
    // cell — nothing is hidden, nothing is misaligned.
    const merges = new Map<string, number>();
    for (const m of (ws["!merges"] ?? []) as XLSX.Range[]) {
      if (m.s.r !== m.e.r) continue;
      if (m.e.c > m.s.c) merges.set(`${m.s.r}:${m.s.c}`, m.e.c - m.s.c + 1);
    }
    return { ws, totalRows, totalCols, widths, merges };
  }, [workbook, name]);

  const numCols = Math.min(MAX_COLS, sheet.totalCols);

  /** Build only the rows currently on screen. */
  const rows = useMemo(() => {
    const { ws, merges } = sheet;
    if (!ws) return [] as GridCell[][];
    const out: GridCell[][] = [];
    const last = Math.min(sheet.totalRows, view.first + view.count);
    for (let r = view.first; r < last; r++) {
      const row: GridCell[] = [];
      let coverUntil = -1;
      for (let c = 0; c < numCols; c++) {
        const base = toGridCell(ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject);
        if (c <= coverUntil) {
          row.push({ ...base, covered: true });
          continue;
        }
        const span = merges.get(`${r}:${c}`) ?? 1;
        if (span > 1) coverUntil = c + span - 1;
        row.push(span > 1 ? { ...base, span } : base);
      }
      out.push(row);
    }
    return out;
  }, [sheet, view.first, view.count, numCols]);

  /** Recompute the window from the scroll container's geometry. */
  const measure = useCallback(() => {
    const el = gridRef.current;
    if (!el) return;
    const first = Math.max(0, Math.floor(el.scrollTop / ROW_H) - OVERSCAN);
    const count = Math.ceil(el.clientHeight / ROW_H) + OVERSCAN * 2;
    setView((prev) => (prev.first === first && prev.count === count ? prev : { first, count }));
  }, []);

  useLayoutEffect(() => {
    measure();
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, workbook, name]);

  /** Put an absolute row inside the window, then run `after` once it is drawn. */
  const scrollRowIntoView = useCallback((r: number, after?: () => void) => {
    const el = gridRef.current;
    if (!el) return;
    const top = r * ROW_H;
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight - ROW_H * 2;
    if (top < viewTop || top > viewBottom) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    }
    if (after) requestAnimationFrame(() => requestAnimationFrame(after));
  }, []);

  // An agent's target range: scroll to it even when it is 40,000 rows down.
  // `scrollIntoView` on the cell can't do this any more — outside the window
  // the cell isn't in the DOM at all.
  useEffect(() => {
    if (!hl) return;
    scrollRowIntoView(hl.r1);
  }, [hl, sheetIdx, workbook, scrollRowIntoView]);

  const focusCell = useCallback(
    (r: number, c: number) => {
      if (r < 0 || c < 0 || r >= sheet.totalRows || c >= numCols) return;
      scrollRowIntoView(r, () => {
        gridRef.current
          ?.querySelector<HTMLTableCellElement>(`td[data-r="${r}"][data-c="${c}"]`)
          ?.focus();
      });
    },
    [scrollRowIntoView, sheet.totalRows, numCols],
  );

  /** Remember a committed change so the cell can be marked and undone. */
  function recordEdit(sheetName: string, ref: string, before: string, after: string) {
    const key = `${sheetName}!${ref}`;
    setEdits((prev) => {
      const seen = prev.find((e) => e.key === key);
      const rest = prev.filter((e) => e.key !== key);
      // Editing a cell back to what the file held is not a change to undo.
      if ((seen?.before ?? before) === after) return rest;
      return [...rest, { key, sheet: sheetName, ref, before: seen?.before ?? before, after }];
    });
  }

  /** Put the most recent changed cell back, in the file and on screen. */
  const undoLastEdit = useCallback(() => {
    setEdits((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      onEditCell?.(last.sheet, last.ref, last.before);
      setNotice(`${last.ref} put back to "${last.before || "(empty)"}".`);
      return prev.slice(0, -1);
    });
  }, [onEditCell]);

  // ⌘Z, where it is expected. Live QA pressed it and nothing happened, because
  // the grid never had an undo of its own and Monaco's was nowhere near.
  useEffect(() => {
    if (!editable) return;
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "z" || e.shiftKey) return;
      // While a cell editor is open, ⌘Z belongs to the text field.
      if (editing) return;
      e.preventDefault();
      undoLastEdit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, editing, undoLastEdit]);

  /** Committed value for a cell, when this session changed it. The workbook in
   * memory was parsed from the bytes as they were on open, so without this the
   * grid would keep showing the OLD value after a successful write. */
  const editedAt = useCallback(
    (sheetName: string, ref: string) => edits.find((e) => e.key === `${sheetName}!${ref}`),
    [edits],
  );

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
        recordEdit(name, ref, at.seed, at.value);
      }
    }
    setEditing(null);
    // Enter saves and steps on, the way a spreadsheet does — otherwise a
    // keyboard user is stranded on the cell they just typed into.
    if (at && move) focusCell(at.r + move.dr, at.c + move.dc);
  }

  if (loading) return <div className="empty-hint">Opening spreadsheet…</div>;
  if (readError) return <div className="empty-hint">{readError}</div>;
  if (!workbook || workbook.SheetNames.length === 0) {
    return <div className="empty-hint">Could not parse this spreadsheet.</div>;
  }

  const { totalRows, totalCols, widths } = sheet;
  // Only decorate when we're on the sheet the highlight refers to.
  const hlActive =
    hl && (targetSheetIdx == null || targetSheetIdx === activeIdx) ? hl : null;
  const inHl = (i: number, j: number) =>
    !!hlActive && i >= hlActive.r1 && i <= hlActive.r2 && j >= hlActive.c1 && j <= hlActive.c2;

  const lastRendered = Math.min(totalRows, view.first + view.count);
  const padTop = view.first * ROW_H;
  const padBottom = Math.max(0, (totalRows - lastRendered) * ROW_H);

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
                if (gridRef.current) gridRef.current.scrollTop = 0;
              }}
            >
              {n}
            </button>
          ))}
        </div>
      )}
      {readOnlyReason && (
        <div className="viewer-status sheet-readonly" role="status">
          {readOnlyReason}
        </div>
      )}
      {editable && (
        <div className="viewer-status sheet-editbar">
          <span>
            Editing — click a cell, or move with the arrow keys and press Enter
            to change it; each change saves into the file immediately. Formula
            cells show their source, but only a value can be saved back.
          </span>
          {/* There is no Save here to press, so the changed-cell count IS the
              receipt — and the way back out. */}
          {edits.length > 0 && (
            <span className="sheet-edits">
              <strong>
                {edits.length} cell{edits.length === 1 ? "" : "s"} changed
              </strong>
              <button className="subtle" onClick={undoLastEdit}>
                Undo {edits[edits.length - 1].ref} ⌘Z
              </button>
            </span>
          )}
        </div>
      )}
      {editable && notice && (
        <div className="viewer-status sheet-notice" role="status">
          {notice}
        </div>
      )}
      <div className="sheet-scroll" ref={gridRef} onScroll={measure}>
        <table role="grid" aria-readonly={!editable} aria-rowcount={totalRows}>
          <colgroup>
            <col className="sheet-corner-col" />
            {Array.from({ length: numCols }, (_, j) => (
              <col key={j} style={{ width: widths[j] ?? DEFAULT_COL_W }} />
            ))}
          </colgroup>
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
            {/* Spacers carry the height of the rows that aren't drawn, so the
                scrollbar reflects the WHOLE sheet — 90,000 rows and all. */}
            {padTop > 0 && (
              <tr aria-hidden style={{ height: padTop }}>
                <td colSpan={numCols + 1} />
              </tr>
            )}
            {rows.map((row, ri) => {
              const i = view.first + ri;
              return (
                <tr key={i} style={{ height: ROW_H }} aria-rowindex={i + 1}>
                  {/* Sticky 1-based row number; label "1" == sheet row 1. */}
                  <th className="sheet-rowhead">{i + 1}</th>
                  {row.map((cell, j) => {
                    if (cell.covered) return null;
                    // Right-align cells that read as numbers (currency/percent
                    // symbols tolerated) so columns of figures line up — unless
                    // the file states an alignment of its own.
                    const changed = editable
                      ? editedAt(name, `${colLetters(j)}${i + 1}`)
                      : undefined;
                    const raw = changed ? changed.after : cell.text;
                    const numeric =
                      raw.trim() !== "" &&
                      !Number.isNaN(Number(raw.replace(/[$£€,%\s]/g, "")));
                    const cls =
                      [
                        inHl(i, j) ? "cell-hl" : "",
                        editable ? "cell-editable" : "",
                        changed ? "cell-changed" : "",
                        cell.formula ? "cell-formula" : "",
                        numeric && !cell.style?.textAlign ? "num" : "",
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
                            focusCell(i, j);
                          }
                        }}
                      />
                    ) : (
                      raw
                    );
                    // `typed` is the character that opened the editor (Excel's
                    // type-to-replace); `seed` stays the cell's own content so
                    // that counts as a change and a bare click does not.
                    const startEdit = (typed?: string) =>
                      setEditing({
                        r: i,
                        c: j,
                        value: typed ?? changed?.after ?? cell.edit,
                        seed: changed?.after ?? cell.edit,
                      });
                    return (
                      <td
                        key={j}
                        className={cls}
                        style={cell.style}
                        colSpan={cell.span > 1 ? cell.span : undefined}
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
              );
            })}
            {padBottom > 0 && (
              <tr aria-hidden style={{ height: padBottom }}>
                <td colSpan={numCols + 1} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {/* Trimming must always be visible — a wide report silently stopping at
          column BH reads as "those columns aren't in the file". Rows no longer
          trim at all. */}
      {totalCols > MAX_COLS && (
        <div className="viewer-status">
          {`Showing the first ${MAX_COLS} of ${totalCols.toLocaleString()} columns (up to ${colLetters(
            MAX_COLS - 1,
          )})`}
        </div>
      )}
    </div>
  );
}
