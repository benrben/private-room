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
  let inString = false;
  for (let index = 0; index < str.length; index += 1) {
    inString = countSeparator(str.charAt(index), inString, counts);
  }
  return rankedSeparators(counts).at(-1)![0];
}

function countSeparator(
  character: string,
  inString: boolean,
  counts: Map<string, number>,
): boolean {
  if (character === '"') return !inString;
  if (!inString && character in SEP_WEIGHT) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  return inString;
}

function rankedSeparators(counts: Map<string, number>): [string, number][] {
  const ranked = [...counts.entries()];
  if (!ranked.length) ranked.push(...Object.entries(SEP_WEIGHT));
  ranked.sort((a, b) => a[1] - b[1] || SEP_WEIGHT[a[0]] - SEP_WEIGHT[b[0]]);
  return ranked;
}

type CsvScan = {
  column: number;
  end: number;
  inString: boolean;
  quoted: Set<string>;
  row: number;
  separatorCode: number;
  source: string;
  start: number;
  startCode: number;
};

function directiveEnd(source: string): number | null {
  const newline = source.charCodeAt(5);
  if (newline === 13 && source.charCodeAt(6) === 10) return 7;
  if (newline === 13 || newline === 10) return 6;
  return null;
}

function separatorSource(source: string): {
  separator: string;
  source: string;
} {
  if (!source.startsWith("sep=")) {
    return { separator: guessSep(source.slice(0, 1024)), source };
  }
  const end = directiveEnd(source);
  if (end === null)
    return { separator: guessSep(source.slice(0, 1024)), source };
  return { separator: source.charAt(4), source: source.slice(end) };
}

function startScan(source: string, separator: string): CsvScan {
  return {
    column: 0,
    end: 0,
    inString: false,
    quoted: new Set<string>(),
    row: 0,
    separatorCode: separator.charCodeAt(0),
    source,
    start: 0,
    startCode: source.charCodeAt(0),
  };
}

function finishCell(scan: CsvScan, delimiter: number): void {
  let field = scan.source.slice(scan.start, scan.end);
  if (field.slice(-1) === "\r") field = field.slice(0, -1);
  if (field.charAt(0) === '"' && field.charAt(field.length - 1) === '"') {
    scan.quoted.add(`${colLetters(scan.column)}${scan.row + 1}`);
  }
  scan.start = scan.end + 1;
  scan.startCode = scan.source.charCodeAt(scan.start);
  if (delimiter === scan.separatorCode) scan.column += 1;
  else {
    scan.column = 0;
    scan.row += 1;
  }
}

function toggleQuote(scan: CsvScan): void {
  if (scan.startCode === 0x22) scan.inString = !scan.inString;
}

function finishCarriageReturn(scan: CsvScan): void {
  if (scan.inString) return;
  if (scan.source.charCodeAt(scan.end + 1) === 0x0a) scan.end += 1;
  finishCell(scan, 0x0d);
}

function isDelimiter(scan: CsvScan, code: number): boolean {
  return code === scan.separatorCode || code === 0x0a;
}

function finishDelimiter(scan: CsvScan, code: number): void {
  if (!scan.inString) finishCell(scan, code);
}

function scanCells(scan: CsvScan): void {
  for (; scan.end < scan.source.length; scan.end += 1) {
    const code = scan.source.charCodeAt(scan.end);
    if (code === 0x22) {
      toggleQuote(scan);
      continue;
    }
    if (code === 0x0d) {
      finishCarriageReturn(scan);
      continue;
    }
    if (isDelimiter(scan, code)) finishDelimiter(scan, code);
  }
}

function finishFinalCell(scan: CsvScan): void {
  if (scan.end - scan.start > 0) finishCell(scan, -1);
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
  const { separator, source } = separatorSource(text);
  const scan = startScan(source, separator);
  scanCells(scan);
  finishFinalCell(scan);
  return scan.quoted;
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
export function stripQuotedCsvFormulas(
  sheet: Record<string, unknown>,
  text: string,
): void {
  for (const ref of quotedCsvCells(text)) {
    const cell = sheet[ref] as { f?: string; v?: unknown } | undefined;
    if (
      cell &&
      cell.f &&
      typeof cell.v === "string" &&
      cell.v === `=${cell.f}`
    ) {
      delete cell.f;
    }
  }
}
