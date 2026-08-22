/**
 * Vitest port of the CSV/TSV-relevant tests in
 * `src-tauri/src/commands/spreadsheet.rs`'s `mod tests` — `parse_a1`/
 * `is_a1_range` are covered by `fileTools.test.ts` (already ported there), so
 * only the delimited-file round-trip tests are ported here, plus
 * `set_cell_in_bytes`'s csv branch and its honest `.xlsx` refusal.
 */

import { describe, expect, it } from "vitest";
import { delimStyle, guessSep, parseDelim, serializeDelim, setCellInBytes } from "./editMatchCells.js";

function setCell(name: string, src: string, cell: string, value: string): { text: string } {
  const r = setCellInBytes(name, Buffer.from(src, "utf8"), null, cell, value);
  if (!r.ok) {
    throw new Error(`expected a write, got: ${r.error}`);
  }
  expect(r.bytes.toString("utf8")).toBe(r.text);
  return { text: r.bytes.toString("utf8") };
}

function refusal(name: string, bytes: Buffer, cell: string, value: string): string {
  const r = setCellInBytes(name, bytes, null, cell, value);
  if (r.ok) {
    throw new Error("expected a refusal");
  }
  return r.error;
}

describe("parseDelim / serializeDelim", () => {
  it("round-trips CSV, preserving quoting", () => {
    const src = 'name,note\nalice,"hi, there"\nbob,"say ""hey"""\n';
    const rows = parseDelim(src, ",");
    expect(rows[1]![1]).toBe("hi, there");
    expect(rows[2]![1]).toBe('say "hey"');
    expect(parseDelim(serializeDelim(rows, ","), ",")).toEqual(rows);
  });

  it("a bare CR ends a row (classic Mac exports)", () => {
    // Dropping it fused the last field of each line to the first of the next
    // — one row where the file has hundreds, made permanent by the next write.
    expect(parseDelim("a,b\rc,d\r", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("a CR or LF inside a quoted field is data, not a row end", () => {
    expect(parseDelim('a,"line1\nline2"\n', ",")).toEqual([["a", "line1\nline2"]]);
  });
});

describe("guessSep / delimStyle", () => {
  it("picks the most frequent separator, comma winning a tie", () => {
    expect(guessSep("a,b,c\n1,2,3\n")).toBe(",");
    expect(guessSep("a\tb\tc\n1\t2\t3\n")).toBe("\t");
    expect(guessSep("a;b;c\n1;2;3\n")).toBe(";");
    expect(guessSep("a|b|c\n1|2|3\n")).toBe("|");
    // No separator at all: a comma.
    expect(guessSep("just one column\n")).toBe(",");
    // A tie goes to the higher-weighted separator (comma over tab).
    expect(guessSep("a,b\tc\n")).toBe(",");
  });

  it("ignores separators inside quoted fields", () => {
    expect(guessSep('a;b\n"x,y,z,w,v";q\n')).toBe(";");
  });

  it("reads the file's own line ending and trailing-newline convention", () => {
    expect(delimStyle("a,b\r\n1,2\r\n")).toEqual({ newline: "\r\n", trailingNewline: true });
    expect(delimStyle("a,b\n1,2")).toEqual({ newline: "\n", trailingNewline: false });
    expect(delimStyle("")).toEqual({ newline: "\n", trailingNewline: true });
  });
});

describe("setCellInBytes (csv/tsv)", () => {
  it("leaves a quoted literal formula-looking value quoted after an unrelated edit", () => {
    // RFC 4180: the quoted field IS the string "=SUM(A1:A2)". Re-writing it
    // bare while editing a DIFFERENT cell would hand the next reader a formula.
    expect(setCell("t.csv", 'label,note\ntotal,"=SUM(A1:A2)"\n', "A2", "sum").text).toBe(
      'label,note\nsum,"=SUM(A1:A2)"\n'
    );
  });

  it("leaves an UNQUOTED formula field exactly as unquoted as it was", () => {
    expect(setCell("t.csv", "label,note\ntotal,=SUM(A1:A2)\n", "A2", "sum").text).toBe("label,note\nsum,=SUM(A1:A2)\n");
  });

  it("quotes a newly-written value that starts with a formula-trigger character", () => {
    // A value pasted verbatim from a web page (a phone number starting `+`, a
    // negative figure, a handle starting `@`) must not silently become live.
    for (const value of ["=1+1", "+123", "-5", "@who"]) {
      expect(setCell("t.csv", "a,b\n1,2\n", "A2", value).text).toBe(`a,b\n"${value}",2\n`);
    }
  });

  it("keeps the file's own line-ending convention (CRLF)", () => {
    expect(setCell("t.csv", "a,b\r\n1,2\r\n", "B2", "9").text).toBe("a,b\r\n1,9\r\n");
  });

  it("honours an Excel `sep=` header line as configuration, not as row 1", () => {
    // The grid's row 1 is the file's SECOND line, and the header is written
    // back verbatim so the addresses stay lined up.
    expect(setCell("t.csv", "sep=;\r\na;b\r\n1;2\r\n", "B2", "9").text).toBe("sep=;\r\na;b\r\n1;9\r\n");
  });

  it("extends a short row/grid to reach a cell past the current bounds", () => {
    const rows = parseDelim(setCell("t.csv", "a\n1\n", "C3", "x").text, ",");
    expect(rows[2]![2]).toBe("x");
  });

  it("works for .tsv as well as .csv", () => {
    expect(setCell("t.tsv", "a\tb\n1\t2\n", "B2", "9").text).toBe("a\tb\n1\t9\n");
  });

  it("rejects a malformed cell reference", () => {
    expect(refusal("t.csv", Buffer.from("a,b\n1,2\n"), "not-a-cell", "x")).toContain("is not a cell");
  });

  it("refuses a non-UTF-8 csv file rather than mangling it", () => {
    const latin1 = Buffer.from([0x61, 0xe8, 0x2c, 0x62, 0x0a]); // "aè,b\n"
    expect(refusal("t.csv", latin1, "A1", "x")).toContain("UTF-8");
  });

  it("reports a clear not-yet-supported error for .xlsx rather than fabricating a binary writer", () => {
    expect(refusal("sheet.xlsx", Buffer.from("PK fake"), "A1", "x")).toMatch(/not supported by this port/i);
  });

  it("refuses an unsupported file type outright", () => {
    expect(refusal("notes.txt", Buffer.from("hi"), "A1", "x")).toContain("not an editable spreadsheet");
  });
});
