/**
 * Vitest port of `src-tauri/src/extraction/window.rs`'s `#[cfg(test)] mod
 * tests` — all six of them:
 *
 *   - filter_keeps_prose_drops_junk
 *   - filter_keeps_citations_and_table_rows
 *   - filter_keeps_repeated_rows_and_collapses_only_long_runs
 *   - partition_covers_everything_without_gaps
 *   - partition_prefers_paragraph_seams
 *   - partition_survives_a_wall_of_text_and_multibyte
 *
 * Plus a byte-vs-codepoint regression test that the Rust suite has no
 * separate name for (it is implicit in every Rust `&str` operation): a
 * non-ASCII line long enough in BYTES but not in CODEPOINTS must still be
 * judged by the byte-length gate `looks_like_noise` opens with.
 */

import { describe, expect, it } from "vitest";
import { byteLength, partitionWindows, sliceUtf8, smartFilter } from "./extractionWindow.js";

describe("smartFilter", () => {
  it("filter_keeps_prose_drops_junk", () => {
    const blob = "QmFzZTY0anVuaw".repeat(9); // 126-char unbroken run
    const text =
      `A normal sentence about a lease agreement.\n${blob}\n` +
      "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\n" +
      "Another useful line.";
    const f = smartFilter(text);
    expect(f).toContain("lease agreement");
    expect(f).toContain("Another useful line");
    expect(f).not.toContain("QmFzZTY0");
    expect(f).not.toContain("~~~~");
  });

  it("filter_keeps_citations_and_table_rows", () => {
    // Regression: one 80+ char token used to drop the whole line, so
    // reference lists and "data available at …" lines disappeared from every
    // summary with nothing saying anything had been cut.
    const cite =
      "Smith, J. (2020). A study of things. Journal of Things 4(2). " +
      "Data available at https://example.org/datasets/2020/a-very-long-identifier-here-1234567890";
    // And compact table rows, which the symbol-ratio rule caught even though
    // the comment beside it promised tables pass through.
    const asciiRow = "| Widget A | 12 | 3.50 | In stock | Warehouse 4 | 2026-01-01 |";
    const boxRow = "│ Widget A │ 12 │ 3.50 │ In stock │ Warehouse 4 │ 2026-01-01 │";
    const text = `${cite}\n${asciiRow}\n${boxRow}`;
    const f = smartFilter(text);
    expect(f, `citation dropped: ${f}`).toContain("Smith, J.");
    expect(f, `url dropped: ${f}`).toContain("a-very-long-identifier");
    expect(f, `ascii table row dropped: ${f}`).toContain("| Widget A |");
    expect(f, `box table row dropped: ${f}`).toContain("│ Widget A │");
  });

  it("filter_keeps_repeated_rows_and_collapses_only_long_runs", () => {
    // A ledger's repeated rows ARE the answer to "how many"; collapsing
    // consecutive duplicates to one used to delete them silently.
    const row = "Cash | 0.00 | 0.00";
    const ledger = `Opening balance\n${row}\n${row}\n${row}\nClosing balance`;
    let f = smartFilter(ledger);
    expect(f.split(row).length - 1, `ledger rows dropped: ${f}`).toBe(3);

    // Past the run cap the lines go, but the count stays — a collapsed run
    // never reads as a complete block.
    const MAX_IDENTICAL_RUN = 6;
    const flood = `Intro\n${Array(MAX_IDENTICAL_RUN + 4).fill(row).join("\n")}\nOutro`;
    f = smartFilter(flood);
    expect(f.split(row).length - 1, `cap ignored: ${f}`).toBe(MAX_IDENTICAL_RUN);
    expect(f, `loss unrecorded: ${f}`).toContain("[4 more identical lines omitted]");
    expect(f, `text after the run lost: ${f}`).toContain("Outro");

    // Exactly at the cap nothing is removed and nothing is claimed.
    const atCap = Array(MAX_IDENTICAL_RUN).fill(row).join("\n");
    expect(smartFilter(atCap), "noted a run it kept").not.toContain("omitted");

    // One line past the cap reads in the singular.
    const oneOver = Array(MAX_IDENTICAL_RUN + 1).fill(row).join("\n");
    expect(smartFilter(oneOver)).toContain("[1 more identical line omitted]");

    // Blank runs still collapse to a single break.
    f = smartFilter("Body text one.\n\n\n\nBody text two.");
    expect(f).not.toContain("\n\n\n");
  });

  it("judges noise by BYTE length, not codepoint count", () => {
    // "é" is 2 bytes in UTF-8 but 1 codepoint. A line of 39 of them is 78
    // bytes (>= 40, the noise gate) but only 39 codepoints — a port that
    // measured the gate in codepoints would let this line's symbol ratio be
    // judged at all, and one that measured everything in bytes (including
    // the wordish ratio) would double-count non-ASCII prose as noise. This
    // line is legitimate prose (an accented word repeated) and must survive.
    const prose = "café ".repeat(20).trim(); // > 40 bytes, all wordish
    expect(byteLength(prose)).toBeGreaterThanOrEqual(40);
    const f = smartFilter(prose);
    expect(f).toContain("café");
  });

  it("keeps POINTED HEBREW — is_alphanumeric is Alphabetic, not \\p{L}", () => {
    // Rust's `char::is_alphanumeric()` is `is_alphabetic() || is_numeric()`,
    // and `is_alphabetic()` is the DERIVED Alphabetic property — which
    // includes Other_Alphabetic combining marks whose general category is Mn,
    // not L. Hebrew niqqud (U+05B0–U+05BD) is entirely in that gap.
    //
    // A port that spelled `is_alphanumeric` as `\p{L}` scores this line at
    // 10 wordish of 16 codepoints = 0.625, under the 0.7 ratio, so
    // `looks_like_noise` returns true and `smart_filter` DELETES a real
    // sentence of Hebrew scripture/poetry before the model ever sees it —
    // silently, with no "[… omitted]" note, because the noise branch does not
    // leave one. Two bytes per letter plus two per point means the 40-byte
    // gate opens after only ~10 letters, so this is not an edge case.
    const pointed = "שָׁלוֹם עֲלֵיכֶם חֲבֵרִים יְקָרִים";
    expect(byteLength(pointed)).toBeGreaterThanOrEqual(40);
    const f = smartFilter(pointed);
    expect(f, `pointed Hebrew dropped as noise: ${JSON.stringify(f)}`).toContain("שָׁלוֹם");
    expect(f).toContain("יְקָרִים");
  });

  it("still drops a genuine symbol blob, pointed or not", () => {
    // The other direction of the same fix: widening the wordish class must
    // not make the noise rule toothless.
    expect(smartFilter("~".repeat(48))).toBe("");
    expect(smartFilter(`keep me\n${"~".repeat(48)}\nkeep me too`)).toBe("keep me\nkeep me too\n");
  });
});

describe("partitionWindows", () => {
  it("partition_covers_everything_without_gaps", () => {
    const text = "A paragraph of prose.\n\n".repeat(500); // ~11.5 KB
    const spans = partitionWindows(text, 2_000, 200);
    // Full coverage: first starts at 0, last ends at len, no gaps between one
    // window's end and the next window's coverage (overlap <= 200 back).
    expect(spans[0]?.[0]).toBe(0);
    expect(spans[spans.length - 1]?.[1]).toBe(byteLength(text));
    for (let i = 0; i < spans.length - 1; i++) {
      const [, prevEnd] = spans[i] as [number, number];
      const [nextStart] = spans[i + 1] as [number, number];
      expect(nextStart, "gap between windows").toBeLessThanOrEqual(prevEnd);
      expect(prevEnd - nextStart, "overlap exceeds the cap").toBeLessThanOrEqual(200);
    }
    // Windows respect the target within the seam slack.
    for (const [s, e] of spans) {
      expect(e - s).toBeLessThanOrEqual(2_000 + 200);
      expect(sliceUtf8(text, s, e)).not.toBeNull();
    }
  });

  it("partition_prefers_paragraph_seams", () => {
    const text = `${"x".repeat(1_800)}\n\n${"y".repeat(3_000)}`;
    const spans = partitionWindows(text, 2_000, 100);
    // First cut lands on the paragraph break, not mid-y.
    expect(spans[0]?.[1]).toBe(1_802);
  });

  it("partition_survives_a_wall_of_text_and_multibyte", () => {
    // No whitespace at all: it must still advance and never split a char.
    const wall = "é".repeat(5_000); // 10 KB, 2 bytes/char
    const spans = partitionWindows(wall, 2_000, 100);
    expect(spans.length).toBeGreaterThanOrEqual(4);
    expect(spans[spans.length - 1]?.[1]).toBe(byteLength(wall));
    for (let i = 0; i < spans.length - 1; i++) {
      const cur = spans[i] as [number, number];
      const next = spans[i + 1] as [number, number];
      expect(next[0]).toBeLessThan(next[1]);
      expect(cur[1]).toBeGreaterThan(cur[0]);
      expect(next[1], "windows must make forward progress").toBeGreaterThan(cur[1]);
    }
    for (const [s, e] of spans) {
      expect(sliceUtf8(wall, s, e)).not.toBeNull();
    }
    // Empty text -> no windows; tiny text -> one window.
    expect(partitionWindows("", 2_000, 100)).toEqual([]);
    expect(partitionWindows("short", 2_000, 100)).toEqual([[0, 5]]);
  });
});

describe("sliceUtf8", () => {
  it("refuses a range that lands mid-character", () => {
    const text = "é"; // 2 bytes: 0xC3 0xA9
    expect(sliceUtf8(text, 0, 1)).toBeNull();
    expect(sliceUtf8(text, 0, 2)).toBe("é");
  });

  it("refuses an out-of-bounds range", () => {
    expect(sliceUtf8("abc", 0, 10)).toBeNull();
    expect(sliceUtf8("abc", 2, 1)).toBeNull();
  });
});
