// Port of `an_oversize_download_is_noticed_while_it_is_still_arriving`'s pure
// half (src-tauri/src/browser.rs) and of `safe_file_name`'s behaviour
// (src-tauri/src/web/fetch.rs).

import { describe, expect, it } from "vitest";
import { MAX_DOWNLOAD_BYTES, downloadOverLimit, safeFileName } from "./downloads.js";

describe("downloadOverLimit", () => {
  it("is over the limit only STRICTLY above the cap", () => {
    // The same number the import funnel applies at the end — the warning exists
    // to say early what that funnel will decide, so a file exactly at the
    // ceiling is not warned about.
    expect(downloadOverLimit(0)).toBe(false);
    expect(downloadOverLimit(MAX_DOWNLOAD_BYTES)).toBe(false);
    expect(downloadOverLimit(MAX_DOWNLOAD_BYTES + 1)).toBe(true);
  });

  it("keeps the D15 ceiling a room file can actually hold", () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(900 * 1024 * 1024);
  });
});

describe("safeFileName", () => {
  it("keeps an ordinary filename untouched", () => {
    expect(safeFileName("quarterly-report_v2.pdf")).toBe("quarterly-report_v2.pdf");
  });

  it("neutralizes path traversal and shell metacharacters", () => {
    expect(safeFileName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(safeFileName("a;rm -rf /.txt")).toBe("a_rm_-rf__.txt");
    expect(safeFileName("x/y")).toBe("x_y");
  });

  it("keeps Unicode letters and digits, like Rust's char::is_alphanumeric", () => {
    expect(safeFileName("דוח.pdf")).toBe("דוח.pdf");
  });

  it("caps length at 80 CHARACTERS, counted the way Rust counts them", () => {
    expect(safeFileName("a".repeat(200))).toHaveLength(80);
    // Astral-plane input: 80 CODE POINTS, like Rust's `.chars().take(80)`, not
    // 80 UTF-16 code units (which would keep only 40 of these).
    const gothicA = "\u{10330}"; // an alphanumeric character outside the BMP
    const capped = safeFileName(gothicA.repeat(200));
    expect(Array.from(capped)).toHaveLength(80);
    expect(capped.length).toBe(160);
  });

  it("replaces a non-alphanumeric astral character, exactly as Rust's is_alphanumeric does", () => {
    // An emoji is neither a letter nor a number, so every one becomes `_` — and
    // a name that is only underscores once cleaned carries no information.
    expect(safeFileName("😀😀😀")).toBe("download");
  });

  it("falls back to 'download' for anything that is only dots/underscores once cleaned", () => {
    expect(safeFileName("")).toBe("download");
    expect(safeFileName("...")).toBe("download");
    expect(safeFileName("///")).toBe("download");
    expect(safeFileName("__.__")).toBe("download");
  });

  it("keeps a name that has SOMETHING left after trimming dots and underscores", () => {
    // Rust trims only to decide emptiness; the returned name is the untrimmed
    // cleaned one.
    expect(safeFileName("_report_")).toBe("_report_");
    expect(safeFileName("-")).toBe("-");
  });
});
