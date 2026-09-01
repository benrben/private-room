import { describe, expect, it } from "vitest";
import {
  colLetters,
  quotedCsvCells,
  stripQuotedCsvFormulas,
} from "./csvquoting";

function quoted(text: string): string[] {
  return [...quotedCsvCells(text)].sort();
}

describe("colLetters", () => {
  it("uses spreadsheet A1 column names beyond Z", () => {
    expect([0, 25, 26, 51, 701, 702].map(colLetters)).toEqual([
      "A",
      "Z",
      "AA",
      "AZ",
      "ZZ",
      "AAA",
    ]);
  });
});

describe("quotedCsvCells", () => {
  it("finds quoted values across CRLF rows, embedded separators, and a final field", () => {
    expect(
      quoted('plain,"=SUM(A1:A2)","two, commas"\r\n"  ",next\r\nlast,"tail"'),
    ).toEqual(["A2", "B1", "B3", "C1"]);
  });

  it("uses SheetJS separator guesses and consumes Excel sep directives", () => {
    expect(quoted('a;b;"c,d"')).toEqual(["C1"]);
    expect(quoted('a,b;"c"')).toEqual([]);
    expect(quoted('sep=;\r\n"literal;one";bare\r\nlast;"two"')).toEqual([
      "A1",
      "B2",
    ]);
    expect(quoted('sep=\t\n"tabbed"\tbare')).toEqual(["A1"]);
    expect(quoted('sep=;"quoted";bare')).toEqual(["B1"]);
  });

  it("keeps quote state only for fields that begin quoted", () => {
    expect(quoted('bad"quote,"valid",tail')).toEqual(["B1"]);
    expect(quoted('"first ""quote""\r\nline",plain\r\nbare,"tail"')).toEqual([
      "A1",
      "B2",
    ]);
    expect(quoted('""')).toEqual(["A1"]);
  });
});

describe("stripQuotedCsvFormulas", () => {
  it("removes only formula metadata invented for matching quoted literal cells", () => {
    const sheet: Record<string, unknown> = {
      A1: { f: "SUM(A1:A2)", v: "=SUM(A1:A2)" },
      B1: { f: "OTHER", v: "computed result" },
      C1: { f: "BARE", v: "=BARE" },
      D1: { v: "=no formula" },
    };

    stripQuotedCsvFormulas(sheet, '"=SUM(A1:A2)","=OTHER",=BARE,missing');

    expect(sheet).toEqual({
      A1: { v: "=SUM(A1:A2)" },
      B1: { f: "OTHER", v: "computed result" },
      C1: { f: "BARE", v: "=BARE" },
      D1: { v: "=no formula" },
    });
  });
});
