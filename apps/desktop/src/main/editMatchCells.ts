/**
 * Ported from `src-tauri/src/commands/spreadsheet.rs`'s CSV/TSV half —
 * `commands/edit_match.rs`'s `plan_set_cells` calls `set_cell_in_bytes`
 * directly, so it is ported here as the edit engine's one dependency on that
 * module. `parse_a1`/`is_a1_range` are NOT re-spelled: `fileTools.ts` already
 * ports both verbatim, and they are reused from there.
 *
 * SCOPE: the CSV/TSV branch is ported faithfully and completely. The `.xlsx`
 * branch (`xlsx_set_cell`, via the `umya-spreadsheet` crate — real binary
 * OOXML spreadsheet read-modify-write, including the shared-strings table and
 * style handling) is NOT ported: this project has no xlsx-writing dependency,
 * and `edit_match.rs`'s own test suite exercises no `set_cells` path at all,
 * so there would be no Rust behaviour to check a hand-rolled writer against.
 * Rather than fabricate a plausible-looking binary writer, {@link
 * setCellInBytes} returns a clearly-worded "not supported in this port" error
 * for `.xlsx` — honest about the gap instead of pretending to close it. This
 * is the ONE known functional gap in this port; everything else in
 * `edit_match.rs`'s surface is implemented.
 */

import { parseA1 } from "./fileTools.js";
import { extensionOf } from "./editMatchExtraction.js";

// ------------------------------------------------------------------ delimited

/**
 * One field of a delimited file, plus whether the SOURCE wrote it quoted.
 * RFC 4180 quoting is meaning, not decoration: `"=SUM(A1:A2)"` is the literal
 * string, while the bare spelling is a formula. Dropping the quotes on the way
 * back out — which editing any OTHER cell used to do — silently turns a label
 * into a sum, so the flag rides along through an edit. Ported from
 * `spreadsheet::DelimField`.
 */
export interface DelimField {
  value: string;
  quoted: boolean;
}

/** The leading characters a spreadsheet reader can take as "this cell is a
 * formula, not text". This app's own viewer reacts only to `=`, but a CSV
 * exported for real use may be opened in Excel/Sheets/Numbers, whose import
 * heuristics are the OWASP-documented broader set. Ported from
 * `spreadsheet::FORMULA_TRIGGER_CHARS`. */
const FORMULA_TRIGGER_CHARS = ["=", "+", "-", "@"];

/** A field being WRITTEN rather than read back — quoted when the bare
 * spelling would come back as something else. Ported from
 * `DelimField::written`. */
function delimFieldWritten(value: string): DelimField {
  return { value, quoted: FORMULA_TRIGGER_CHARS.some((c) => value.startsWith(c)) };
}

/** Minimal CSV/TSV parser — quoted fields, embedded delimiters and newlines,
 * keeping each field's original quoting for the writer. Ported from
 * `spreadsheet::parse_delim_quoted`. */
export function parseDelimQuoted(text: string, delim: string): DelimField[][] {
  const rows: DelimField[][] = [];
  let row: DelimField[] = [];
  let field: DelimField = { value: "", quoted: false };
  let inQuotes = false;
  const chars = [...text];
  let i = 0;
  const pushField = (): void => {
    row.push(field);
    field = { value: "", quoted: false };
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < chars.length) {
    const c = chars[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (chars[i + 1] === '"') {
          field.value += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
        continue;
      }
      field.value += c;
      i += 1;
      continue;
    }
    if (c === '"' && field.value === "") {
      inQuotes = true;
      field.quoted = true;
      i += 1;
      continue;
    }
    // A bare CR ENDS THE ROW. Classic Mac exports ("CSV (Macintosh)") still
    // use CR alone, and dropping it fused the last field of each line to the
    // first of the next.
    if (c === "\r") {
      i += 1;
      if (chars[i] === "\n") {
        i += 1;
      }
      pushRow();
      continue;
    }
    if (c === "\n") {
      i += 1;
      pushRow();
      continue;
    }
    if (c === delim) {
      pushField();
      i += 1;
      continue;
    }
    field.value += c;
    i += 1;
  }
  if (field.value !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** The same parse, discarding quoting info. Ported from
 * `spreadsheet::parse_delim`. */
export function parseDelim(text: string, delim: string): string[][] {
  return parseDelimQuoted(text, delim).map((row) => row.map((f) => f.value));
}

/** The line-ending conventions of an existing delimited file, so editing one
 * cell doesn't rewrite every other line. Ported from
 * `spreadsheet::DelimStyle`. */
export interface DelimStyle {
  readonly newline: string;
  readonly trailingNewline: boolean;
}

/** The line ending this file actually uses, taken from the first break
 * OUTSIDE a quoted field — a CR or LF inside a quoted value is data, not a
 * row end. Ported from `spreadsheet::first_line_break`. */
function firstLineBreak(text: string): string | null {
  let inQuotes = false;
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === "\r" && !inQuotes) {
      return chars[i + 1] === "\n" ? "\r\n" : "\r";
    } else if (c === "\n" && !inQuotes) {
      return "\n";
    }
  }
  return null;
}

/** Read the conventions off the file we are about to rewrite. Ported from
 * `spreadsheet::delim_style`. */
export function delimStyle(text: string): DelimStyle {
  return {
    newline: firstLineBreak(text) ?? "\n",
    // An empty file gets the usual trailing newline; otherwise match it.
    trailingNewline: text === "" || text.endsWith("\n") || text.endsWith("\r"),
  };
}

/** Quoting is not optional when the bare spelling would parse back as
 * something else — CR included, since a bare CR ends a row for the parser
 * above. Ported from `spreadsheet::must_quote`. */
function mustQuote(value: string, delim: string): boolean {
  return value.includes(delim) || value.includes('"') || value.includes("\n") || value.includes("\r");
}

/** Write rows that came from {@link parseDelimQuoted}, keeping each field's
 * own quoting — only the field the caller replaced changes shape. Ported from
 * `spreadsheet::serialize_fields_styled`. */
export function serializeFieldsStyled(rows: readonly DelimField[][], delim: string, style: DelimStyle): string {
  const lines = rows.map((row) =>
    row.map((f) => (f.quoted || mustQuote(f.value, delim) ? `"${f.value.split('"').join('""')}"` : f.value)).join(delim)
  );
  let out = lines.join(style.newline);
  if (style.trailingNewline && rows.length > 0) {
    out += style.newline;
  }
  return out;
}

/** Ported from `spreadsheet::serialize_delim_styled`. */
export function serializeDelimStyled(rows: readonly string[][], delim: string, style: DelimStyle): string {
  return serializeFieldsStyled(rows.map((row) => row.map(delimFieldWritten)), delim, style);
}

/** Ported from `spreadsheet::serialize_delim` (default style: `\n`, trailing
 * newline). */
export function serializeDelim(rows: readonly string[][], delim: string): string {
  return serializeDelimStyled(rows, delim, { newline: "\n", trailingNewline: true });
}

/** The separators a delimited file may be read with, and the tie-break
 * weights the grid's reader uses: on an equal count the comma wins, then tab,
 * then semicolon, then pipe. Ported from `spreadsheet::SEP_WEIGHTS`. */
const SEP_WEIGHTS: ReadonlyArray<readonly [string, number]> = [
  [",", 3],
  ["\t", 2],
  [";", 1],
  ["|", 0],
];

/** The separator the file will be READ with — SheetJS's `guess_sep`, which is
 * what the viewer's grid runs on and therefore what decides which field the
 * address "B2" names. Counted outside quotes over the first 1024 characters;
 * a file with none of them is a comma. Ported from `spreadsheet::guess_sep`. */
export function guessSep(text: string): string {
  const counts = SEP_WEIGHTS.map(() => 0);
  let inQuotes = false;
  let seen = 0;
  for (const c of text) {
    if (seen >= 1024) {
      break;
    }
    seen += 1;
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      const idx = SEP_WEIGHTS.findIndex(([s]) => s === c);
      if (idx !== -1) {
        counts[idx] = counts[idx]! + 1;
      }
    }
  }
  let bestIdx = 0;
  for (let i = 1; i < SEP_WEIGHTS.length; i++) {
    if (counts[i]! > counts[bestIdx]! || (counts[i]! === counts[bestIdx]! && SEP_WEIGHTS[i]![1] > SEP_WEIGHTS[bestIdx]![1])) {
      bestIdx = i;
    }
  }
  return SEP_WEIGHTS[bestIdx]![0];
}

/** How a delimited file is read, so a write lands on the cell the grid
 * showed. Ported from `spreadsheet::DelimRead`/`read_as`. */
interface DelimRead {
  /** An Excel-authored `sep=;` line, verbatim with its terminator — the
   * reader consumes it as configuration rather than as row 1, so the grid's
   * row 1 is the file's SECOND line and writing the header back unchanged is
   * what keeps the addresses lined up. */
  readonly header: string;
  readonly body: string;
  readonly delim: string;
}

function readAs(text: string): DelimRead {
  if (text.length >= 6 && text.startsWith("sep=") && text.charCodeAt(4) <= 0x7f) {
    const sep = text[4]!;
    if (text[5] === "\r" && text[6] === "\n") {
      return { header: text.slice(0, 7), body: text.slice(7), delim: sep };
    }
    if (text[5] === "\r" || text[5] === "\n") {
      return { header: text.slice(0, 6), body: text.slice(6), delim: sep };
    }
  }
  return { header: "", body: text, delim: guessSep(text) };
}

// ---------------------------------------------------------------- set a cell

/** Ported from `commands/files.rs`'s `non_utf8_error`. */
function nonUtf8Error(name: string): string {
  return (
    `"${name}" is not saved as UTF-8 text, so editing it here would replace its ` +
    "accented characters with □. Re-save it as UTF-8 first, or save a corrected " +
    "copy as a new file."
  );
}

/** `Result<(Vec<u8>, Option<String>), String>` — the exact shape
 * `spreadsheet::set_cell_in_bytes` returns. A discriminated union rather than
 * a throw, so a caller's error branch can never accidentally swallow an
 * unrelated failure. */
export type SetCellResult =
  | { readonly ok: true; readonly bytes: Buffer; readonly text: string | null }
  | { readonly ok: false; readonly error: string };

/**
 * Set one cell (A1 notation) in spreadsheet bytes, returning the new bytes
 * plus the re-extracted text for the search index. Ported from
 * `spreadsheet::set_cell_in_bytes` — the CSV/TSV branch faithfully; `.xlsx`
 * is the one gap (see this module's own doc).
 */
export function setCellInBytes(
  name: string,
  bytes: Uint8Array,
  _sheet: string | null,
  cellRaw: string,
  value: string
): SetCellResult {
  const cell = cellRaw.trim().toUpperCase();
  const parsed = parseA1(cell);
  if (parsed === null) {
    return { ok: false, error: `"${cell}" is not a cell — use A1 notation like B7.` };
  }
  const [row, col] = parsed;
  const ext = extensionOf(name);
  if (ext === "csv" || ext === "tsv") {
    // Bytes that aren't UTF-8 read back as replacement characters, and writing
    // them out would destroy the file's accented letters for good. Refuse
    // rather than corrupt.
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, error: nonUtf8Error(name) };
    }
    // Split the file the way it is READ. The delimiter used to come from the
    // extension, so a semicolon- or pipe-separated .csv — and any file with
    // Excel's `sep=` line — was written on a grid that was not the one the
    // user clicked in.
    const read = readAs(text);
    const rows = parseDelimQuoted(read.body, read.delim);
    while (rows.length <= row) {
      rows.push([]);
    }
    while (rows[row]!.length <= col) {
      rows[row]!.push({ value: "", quoted: false });
    }
    rows[row]![col] = delimFieldWritten(value);
    // Keep the file's own line endings and final-newline convention, so a
    // one-cell edit reads as a one-line change everywhere else.
    const out = read.header + serializeFieldsStyled(rows, read.delim, delimStyle(read.body));
    return { ok: true, bytes: Buffer.from(out, "utf8"), text: out };
  }
  if (ext === "xlsx") {
    return {
      ok: false,
      error:
        `Setting cells in "${name}" is not supported by this port yet — binary spreadsheet ` +
        `(.xlsx) writing needs a full OOXML reader/writer this project does not have. ` +
        `Nothing was changed. Use a .csv/.tsv file instead.`,
    };
  }
  return {
    ok: false,
    error: `"${name}" is not an editable spreadsheet — cell editing works on .xlsx and .csv files.`,
  };
}
