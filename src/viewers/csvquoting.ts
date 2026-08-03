/** Which fields of a delimited file were QUOTED in the source.
 *
 * RFC 4180 makes a quoted field literal text, and SheetJS throws that fact
 * away: its CSV reader strips the surrounding quotes *before* it decides what
 * the field is, so `"=SUM(A1:A2)"` reaches the grid indistinguishable from a
 * bare `=SUM(A1:A2)` and is marked as a formula. Live QA opened a CSV whose
 * cell held the literal string `=SUM(A1:A2)` and the viewer showed it with a
 * formula corner-mark and a "Formula:" tooltip — a claim about the file that
 * the file does not make.
 *
 * So the source is re-scanned here for the one bit SheetJS discards. The
 * tokenizer below is a deliberate port of `dsv_to_sheet_str` in
 * `node_modules/xlsx/xlsx.mjs` (0.20.3) — separator guess, `sep=` prefix,
 * quote state and CRLF handling all included — because the addresses it
 * produces must be the SAME addresses SheetJS produced, or the wrong cell gets
 * corrected. Any divergence would be silent, which is why the port is literal
 * rather than "a CSV parser".
 *
 * Dependency-free and DOM-free so it is unit-tested directly under
 * `npm run test:page`.
 */

/** 0-based column index → "A", "B", … "AA". */
export function colLetters(c: number): string {
  let n = c + 1;
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(64 + ((n - 1) % 26) + 1) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** The separators SheetJS accepts, with its tie-break weights: on an equal
 * count the comma wins, then tab, then semicolon, then pipe. */
const SEP_WEIGHT: Record<string, number> = { ",": 3, "\t": 2, ";": 1, "|": 0 };

/** SheetJS's `guess_sep`: the most frequent accepted separator outside quotes,
 * weight breaking ties. A file with none of them falls back to the comma. */
function guessSep(str: string): string {
  const counts = new Map<string, number>();
  let instr = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charAt(i);
    if (ch === '"') instr = !instr;
    else if (!instr && ch in SEP_WEIGHT) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let ranked = [...counts.entries()];
  if (ranked.length === 0) ranked = Object.entries(SEP_WEIGHT);
  ranked.sort((a, b) => a[1] - b[1] || SEP_WEIGHT[a[0]] - SEP_WEIGHT[b[0]]);
  return ranked[ranked.length - 1][0];
}

/**
 * A1 addresses of the fields that were written QUOTED in `text`.
 *
 * Empty and whitespace-only quoted fields are included even though SheetJS
 * stores no cell for them — an address with no cell simply has nothing to
 * correct, and leaving them out would mean tracking a second rule that can
 * drift from SheetJS's.
 */
export function quotedCsvCells(text: string): Set<string> {
  let str = text;
  let sep: string;
  // An Excel-authored `sep=;` line is consumed as configuration, not as row 1.
  if (str.slice(0, 4) === "sep=") {
    if (str.charCodeAt(5) === 13 && str.charCodeAt(6) === 10) {
      sep = str.charAt(4);
      str = str.slice(7);
    } else if (str.charCodeAt(5) === 13 || str.charCodeAt(5) === 10) {
      sep = str.charAt(4);
      str = str.slice(6);
    } else {
      sep = guessSep(str.slice(0, 1024));
    }
  } else {
    sep = guessSep(str.slice(0, 1024));
  }

  const quoted = new Set<string>();
  const sepcc = sep.charCodeAt(0);
  let r = 0;
  let c = 0;
  let start = 0;
  let end = 0;
  let instr = false;
  // Quotes only toggle the in-string state when the FIELD began with one, so a
  // stray `"` mid-field can't swallow the rest of the file.
  let startcc = str.charCodeAt(0);

  const finishCell = (cc: number) => {
    let field = str.slice(start, end);
    if (field.slice(-1) === "\r") field = field.slice(0, -1);
    if (field.charAt(0) === '"' && field.charAt(field.length - 1) === '"') {
      quoted.add(`${colLetters(c)}${r + 1}`);
    }
    start = end + 1;
    startcc = str.charCodeAt(start);
    if (cc === sepcc) c++;
    else {
      c = 0;
      r++;
    }
  };

  for (; end < str.length; ++end) {
    const cc = str.charCodeAt(end);
    if (cc === 0x22) {
      if (startcc === 0x22) instr = !instr;
      continue;
    }
    if (cc === 0x0d) {
      if (instr) continue;
      if (str.charCodeAt(end + 1) === 0x0a) ++end;
      finishCell(cc);
      continue;
    }
    if (cc === sepcc || cc === 0x0a) {
      if (!instr) finishCell(cc);
    }
  }
  // A file whose last line has no newline still ends on a field.
  if (end - start > 0) finishCell(-1);
  return quoted;
}

/**
 * Un-mark the formulas SheetJS invented for quoted fields, in place.
 *
 * The guard is deliberately narrow: a CSV "formula" is the only kind whose
 * value is its own source text (`v === "=" + f`), because nothing computed it.
 * A real workbook cell carries the cached RESULT there, so an .xlsx formula
 * cannot be reached by this even if `XLSX.read` sniffed some other parser for
 * the string it was handed.
 */
export function stripQuotedCsvFormulas(sheet: Record<string, unknown>, text: string): void {
  for (const ref of quotedCsvCells(text)) {
    const cell = sheet[ref] as { f?: string; v?: unknown } | undefined;
    if (cell && cell.f && typeof cell.v === "string" && cell.v === `=${cell.f}`) {
      delete cell.f;
    }
  }
}
