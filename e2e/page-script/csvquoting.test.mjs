/* A quoted CSV field is literal text — the sheet viewer's formula rule.
 *
 * RFC 4180: `"=SUM(A1:A2)"` is the STRING =SUM(A1:A2), not a sum. SheetJS
 * strips the quotes before it classifies the field, so both spellings reached
 * the grid with `cell.f` set and a quoted cell claimed to be a formula it
 * isn't. `src/viewers/csvquoting.ts` re-reads the source for the quoting
 * SheetJS discarded; these tests drive the REAL SheetJS the viewer uses, so a
 * SheetJS upgrade that changes its tokenizer fails here rather than in a file.
 *
 * SheetView derives everything a reader sees from `cell.f`: the formula
 * corner-mark, the "Formula:" tooltip and the editor's seed
 * (`cell.f ? "=" + cell.f : shown`). Asserting on `f` is asserting on all three.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";
import * as XLSX from "xlsx";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

async function load(relPath) {
  const source = readFileSync(join(root, relPath), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}

const { quotedCsvCells, stripQuotedCsvFormulas, colLetters } = await load(
  "src/viewers/csvquoting.ts",
);

/** The viewer's own CSV path: read the text, then restore the quoting. */
function readCsv(text) {
  const wb = XLSX.read(text, { type: "string" });
  for (const n of wb.SheetNames) stripQuotedCsvFormulas(wb.Sheets[n], text);
  return wb.Sheets[wb.SheetNames[0]];
}

/** What SheetView would put in the editor when the cell is clicked. */
function editSeed(cell) {
  const shown = cell.w ?? (cell.v == null ? "" : String(cell.v));
  return cell.f ? `=${cell.f}` : shown;
}

test("a quoted =SUM field stays literal text", () => {
  const ws = readCsv('label,value\ntotal,"=SUM(A1:A2)"\n');
  assert.equal(ws.B2.v, "=SUM(A1:A2)");
  // No `f` means no corner-mark, no "Formula:" tooltip…
  assert.equal(ws.B2.f, undefined);
  // …and the editor seeds with the literal text rather than a formula source.
  assert.equal(editSeed(ws.B2), "=SUM(A1:A2)");
});

test("an UNQUOTED =SUM field is still read as a formula", () => {
  // Deliberately unchanged behaviour: a bare leading `=` is how a CSV spells a
  // formula, and the grid keeps marking it as one.
  const ws = readCsv("label,value\ntotal,=SUM(A1:A2)\n");
  assert.equal(ws.B2.f, "SUM(A1:A2)");
  assert.equal(editSeed(ws.B2), "=SUM(A1:A2)");
});

test("both spellings in one file are told apart", () => {
  const ws = readCsv('"=SUM(A1:A2)",=SUM(A1:A2)\n');
  assert.equal(ws.A1.f, undefined);
  assert.equal(ws.B1.f, "SUM(A1:A2)");
});

test("a quoted field with embedded quotes and commas still round-trips", () => {
  const ws = readCsv('note,n\n"he said ""hi"", ok",2\n"=A1,""=B1""",3\n');
  assert.equal(ws.A2.v, 'he said "hi", ok');
  assert.equal(ws.A2.f, undefined);
  // The embedded comma must not shift the columns, or the correction would
  // land on the wrong cell.
  assert.equal(ws.B2.v, 2);
  assert.equal(ws.A3.v, '=A1,"=B1"');
  assert.equal(ws.A3.f, undefined);
  assert.equal(ws.B3.v, 3);
});

test("quoting is tracked across CRLF, a quoted newline and a trailing line", () => {
  const text = 'a,"one\ntwo"\r\n"=X()",b\r\nlast,"=Y()"';
  const quoted = quotedCsvCells(text);
  assert.deepEqual([...quoted].sort(), ["A2", "B1", "B3"]);
  const ws = readCsv(text);
  assert.equal(ws.A2.v, "=X()");
  assert.equal(ws.A2.f, undefined);
  assert.equal(ws.B3.f, undefined);
});

test("a semicolon file is scanned with the separator SheetJS guessed", () => {
  // Guessing the comma here would count columns wrongly and correct the wrong
  // address — the quoted formula would stay marked and B1 would be stripped.
  const text = 'label;"=SUM(A1:A2)";x,y\n';
  const ws = readCsv(text);
  assert.equal(ws.B1.v, "=SUM(A1:A2)");
  assert.equal(ws.B1.f, undefined);
  assert.deepEqual([...quotedCsvCells(text)], ["B1"]);
});

test("an Excel sep= header is consumed, not read as row 1", () => {
  const text = 'sep=;\nlabel;"=SUM(A1:A2)"\n';
  assert.deepEqual([...quotedCsvCells(text)], ["B1"]);
  assert.equal(readCsv(text).B1.f, undefined);
});

test("a real XLSX formula cell is still marked as a formula", () => {
  const ws = XLSX.utils.aoa_to_sheet([[1], [2], [null]]);
  // A workbook formula carries its CACHED RESULT in `v`; that is what keeps the
  // CSV correction away from it.
  ws.A3 = { t: "n", f: "SUM(A1:A2)", v: 3 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" });

  const reread = XLSX.read(bytes, { type: "array", cellStyles: true, cellDates: true });
  const sheet = reread.Sheets[reread.SheetNames[0]];
  assert.equal(sheet.A3.f, "SUM(A1:A2)");
  assert.equal(editSeed(sheet.A3), "=SUM(A1:A2)");
  // Even if the correction were pointed at a workbook, it must not disarm one.
  stripQuotedCsvFormulas(sheet, '"x","y"\n"z","w"\n"p","q"\n');
  assert.equal(sheet.A3.f, "SUM(A1:A2)");
});

test("column letters run past Z", () => {
  assert.equal(colLetters(0), "A");
  assert.equal(colLetters(25), "Z");
  assert.equal(colLetters(26), "AA");
});
