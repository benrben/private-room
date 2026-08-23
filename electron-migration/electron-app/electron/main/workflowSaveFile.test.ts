/**
 * Tests for `workflowSaveFile.ts` — the Rust unit tests
 * `a_saved_file_name_cannot_be_a_pasted_model_reply`,
 * `appending_to_an_html_page_stays_one_document` and
 * `appending_survives_text_that_changes_length_when_lowercased`
 * (`src-tauri/src/commands/jobs/workflow.rs`'s `#[cfg(test)] mod tests`),
 * ported by name, plus the code-point/whitespace edges this port's string
 * units make possible and Rust's own do not.
 *
 * `saveFileNode`'s DB-touching paths live in `workflowEngine.test.ts`, beside
 * the function itself.
 */

import { describe, expect, it } from "vitest";

import { htmlDocument } from "./docsHtml.js";
import { appendIntoHtml, cleanSaveName, MAX_SAVE_NAME_CHARS } from "./workflowSaveFile.js";

// ============================================================================
// clean_save_name
// ============================================================================

describe("cleanSaveName", () => {
  it("a_saved_file_name_cannot_be_a_pasted_model_reply", () => {
    // The name template runs through `interpolate`, so {{input}} can drop a
    // whole answer — newlines, slashes and all — into a file name.
    const long = "word ".repeat(200);
    const cleaned = cleanSaveName(long);
    expect(Array.from(cleaned).length).toBeLessThanOrEqual(MAX_SAVE_NAME_CHARS);
    expect(cleanSaveName("Digest\n2026/07\\18")).toBe("Digest 2026 07 18");
    expect(cleanSaveName("   ")).toBe("Workflow output");
    // An ordinary name is untouched.
    expect(cleanSaveName("Morning digest 2026-08-01")).toBe("Morning digest 2026-08-01");
  });

  it("control characters (C0, DEL, C1) all flatten to spaces, like char::is_control", () => {
    expect(cleanSaveName("a\u0000b\u0007c\u007Fd\u009Fe")).toBe("a b c d e");
  });

  it("counts the cap in Unicode SCALAR VALUES, not UTF-16 code units", () => {
    // 130 astral-plane characters = 260 UTF-16 units. Rust would keep 120
    // CHARACTERS; a UTF-16 slice would keep only 60.
    const emoji = "😀".repeat(130);
    expect(Array.from(cleanSaveName(emoji)).length).toBe(MAX_SAVE_NAME_CHARS);
  });

  it("splits on the Unicode White_Space property, not JS's `\\s`", () => {
    // U+0085 NEL IS White_Space (so Rust splits on it) but is NOT in JS's
    // `\s`; U+FEFF is in `\s` but is NOT White_Space (so Rust keeps it).
    expect(cleanSaveName("a\u0085b")).toBe("a b");
    expect(cleanSaveName("a\uFEFFb")).toBe("a\uFEFFb");
  });

  it("does not leave a trailing space when the cap lands mid-word", () => {
    const name = cleanSaveName(`${"x".repeat(MAX_SAVE_NAME_CHARS - 1)} tail`);
    expect(name.endsWith(" ")).toBe(false);
    expect(Array.from(name).length).toBe(MAX_SAVE_NAME_CHARS - 1);
  });
});

// ============================================================================
// append_into_html
// ============================================================================

describe("appendIntoHtml", () => {
  it("appending_to_an_html_page_stays_one_document", () => {
    // Gluing a whole second document onto the end left stranded footers
    // mid-page and the formatting restarting after a few runs.
    const old = htmlDocument("Digest", "<p>first</p>");
    const joined = appendIntoHtml(old, "Digest", "<p>second</p>");
    expect((joined.match(/<!doctype html>/g) ?? []).length).toBe(1);
    expect((joined.match(/<\/main>/g) ?? []).length).toBe(1);
    expect(joined).toContain("<p>first</p>");
    expect(joined).toContain("<p>second</p>");
    // The new block lands INSIDE the document, before the footer.
    expect(joined.indexOf("<p>second</p>")).toBeLessThan(joined.indexOf("</main>"));
    // A file that isn't a document we recognise becomes one.
    const built = appendIntoHtml("loose text", "Digest", "<p>next</p>");
    expect(built.startsWith("<!doctype html>")).toBe(true);
    expect(built).toContain("loose text");
    expect(built).toContain("<p>next</p>");
  });

  it("appending_survives_text_that_changes_length_when_lowercased", () => {
    // The splice point is an offset into a case-folded copy, so that copy must
    // be the same LENGTH as the original. `.toLowerCase()` is not: 'İ'
    // (U+0130) grows, 'ẞ' (U+1E9E) shrinks — a page carrying either spliced
    // the next block a few units off, into the middle of the closing tag.
    for (const shifty of ["İstanbul İzmir İçel", "STRAẞE ẞ ẞ ẞ ẞ"]) {
      const old = htmlDocument("Digest", `<p>${shifty}</p>`);
      const joined = appendIntoHtml(old, "Digest", "<p>second</p>");
      const at = old.lastIndexOf("</main>");
      expect(at, "fixture is a generated page").toBeGreaterThanOrEqual(0);
      // The block goes in exactly AT `</main>`, nowhere near it.
      expect(joined, `${shifty}: spliced at the wrong offset`).toBe(
        `${old.slice(0, at)}\n<hr/>\n<p>second</p>\n${old.slice(at)}`
      );
      expect((joined.match(/<\/main>/g) ?? []).length, shifty).toBe(1);
      expect(joined, `${shifty}: old content was cut`).toContain(shifty);
    }
  });

  it("falls back to </body> when a page has no <main>, and matches either case", () => {
    const old = "<HTML><BODY><p>one</p></BODY></HTML>";
    const joined = appendIntoHtml(old, "Page", "<p>two</p>");
    expect(joined).toBe("<HTML><BODY><p>one</p>\n<hr/>\n<p>two</p>\n</BODY></HTML>");
  });

  it("splices before the LAST marker, not the first", () => {
    const old = "<main>a</main><main>b</main>";
    const joined = appendIntoHtml(old, "Page", "<p>x</p>");
    expect(joined).toBe("<main>a</main><main>b\n<hr/>\n<p>x</p>\n</main>");
  });
});
