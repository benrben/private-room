/**
 * Tests for `bulkReport.ts`, mirroring `src-tauri/src/commands/bulk.rs`'s own
 * `mod tests` for `BulkReport::changed_anything`/`::sentence` 1:1 where a Rust
 * test exists, plus the boundary cases (>10 failures, a capped batch) the Rust
 * source's own comments call out.
 */

import { describe, expect, it } from "vitest";
import type { BulkReport } from "../shared/apiTypes.js";
import { MAX_BULK_FILES } from "./organize.js";
import { bulkReportChangedAnything, bulkReportSentence } from "./bulkReport.js";

function report(overrides: Partial<BulkReport> = {}): BulkReport {
  return { ok: [], failed: [], capped: 0, ...overrides };
}

describe("bulkReportChangedAnything", () => {
  it("is false for an empty or all-failed batch — no write claimed over a no-op", () => {
    expect(bulkReportChangedAnything(report())).toBe(false);
    expect(bulkReportChangedAnything(report({ failed: [{ name: "b.txt", error: "gone" }] }))).toBe(
      false
    );
  });

  it("is true the moment even one file really changed", () => {
    expect(bulkReportChangedAnything(report({ ok: ["a.txt"] }))).toBe(true);
  });
});

describe("bulkReportSentence — a receipt never claims more than it did", () => {
  // Direct port of bulk.rs's `a_receipt_never_claims_more_than_it_did`.
  it("says nothing was done for an empty report", () => {
    expect(bulkReportSentence(report(), "moved")).toBe("Nothing was moved.");
  });

  it("names the single file for exactly one success", () => {
    expect(bulkReportSentence(report({ ok: ["a.txt"] }), "moved")).toBe('"a.txt" moved.');
  });

  it("counts (not names) two or more successes", () => {
    expect(bulkReportSentence(report({ ok: ["a.txt", "b.txt"] }), "moved")).toBe("2 files moved.");
    expect(bulkReportSentence(report({ ok: ["a", "b", "c"] }), "moved to the trash")).toBe(
      "3 files moved to the trash."
    );
  });

  it("names a failure alongside a success, both in one sentence", () => {
    const s = bulkReportSentence(
      report({ ok: ["a.txt"], failed: [{ name: "b.txt", error: "gone" }] }),
      "moved"
    );
    expect(s).toContain('"a.txt" moved.');
    expect(s).toContain('"b.txt" (gone)');
  });

  it("caps the listed failures at 10 and says how many more there were", () => {
    const failed = Array.from({ length: 13 }, (_, i) => ({ name: `f${i}.txt`, error: "gone" }));
    const s = bulkReportSentence(report({ failed }), "moved");
    expect(s).toContain("13 could not be:");
    expect(s).toContain("…and 3 more");
    // Only the first 10 are actually named.
    expect(s).not.toContain('"f12.txt"');
    expect(s).toContain('"f9.txt"');
  });

  // Direct port of bulk.rs's `the_cap_is_reported_never_silent`.
  it("reports a truncated batch — never silent about the cap", () => {
    const s = bulkReportSentence(report({ ok: ["a.txt"], capped: 5 }), "moved");
    expect(s).toContain(
      `5 more were not attempted — one batch handles at most ${MAX_BULK_FILES} files.`
    );
  });

  it("a fully successful batch mentions neither failures nor the cap", () => {
    expect(bulkReportSentence(report({ ok: ["a.txt"] }), "moved to the trash")).toBe(
      '"a.txt" moved to the trash.'
    );
  });

  it("composes all three clauses (ok, failed, capped) into one exact sentence", () => {
    const s = bulkReportSentence(
      report({ ok: ["a.txt", "b.txt"], failed: [{ name: "c.txt", error: "locked" }], capped: 1 }),
      "moved to the trash"
    );
    expect(s).toBe(
      '2 files moved to the trash. 1 could not be: "c.txt" (locked). ' +
        `1 more were not attempted — one batch handles at most ${MAX_BULK_FILES} files.`
    );
  });
});
