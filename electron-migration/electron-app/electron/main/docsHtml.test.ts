/**
 * Tests for `docsHtml.ts` — the scratch-pad/HTML-first slice of
 * `commands/docs_html.rs` that `execCreateFile` (`organizeTools.ts`)
 * depends on. `htmlDocument`'s wrapping/pass-through behaviour is exercised
 * end-to-end through `execCreateFile` in `organizeTools.test.ts`; these
 * tests cover the smaller pure helpers directly.
 */

import { describe, expect, it } from "vitest";
import {
  htmlDocument,
  htmlEscape,
  isFullHtmlDoc,
  isScratchPadName,
  noteMime,
  SCRATCH_PAD_NAME,
} from "./docsHtml.js";

describe("SCRATCH_PAD_NAME", () => {
  it("is the canonical name", () => {
    expect(SCRATCH_PAD_NAME).toBe("Scratch pad.md");
  });
});

describe("isScratchPadName", () => {
  it("matches the bare stem, any case, with or without .md", () => {
    expect(isScratchPadName("Scratch pad")).toBe(true);
    expect(isScratchPadName("scratch pad")).toBe(true);
    expect(isScratchPadName("SCRATCH PAD.md")).toBe(true);
    expect(isScratchPadName("  Scratch pad  ")).toBe(true);
  });

  it("never hijacks a deliberate other extension", () => {
    expect(isScratchPadName("Scratch pad.html")).toBe(false);
    expect(isScratchPadName("Scratch pad.txt")).toBe(false);
  });

  it("does not match an unrelated name", () => {
    expect(isScratchPadName("Weekly brief.md")).toBe(false);
  });
});

describe("htmlEscape", () => {
  it("escapes the five HTML-sensitive characters", () => {
    expect(htmlEscape(`<b>"AT&T" & sons</b>`)).toBe("&lt;b&gt;&quot;AT&amp;T&quot; &amp; sons&lt;/b&gt;");
  });
});

describe("isFullHtmlDoc", () => {
  it("recognizes a doctype or html start, case- and whitespace-insensitive", () => {
    expect(isFullHtmlDoc("<!doctype html><html></html>")).toBe(true);
    expect(isFullHtmlDoc("  <HTML><body>x</body></html>")).toBe(true);
    expect(isFullHtmlDoc("<h2>just a fragment</h2>")).toBe(false);
  });
});

describe("noteMime", () => {
  it("maps known extensions and defaults everything else to text/plain", () => {
    expect(noteMime("notes.md")).toBe("text/markdown");
    expect(noteMime("page.html")).toBe("text/html");
    expect(noteMime("data.CSV")).toBe("text/csv");
    expect(noteMime("mystery.xyz")).toBe("text/plain");
    expect(noteMime("noext")).toBe("text/plain");
  });
});

describe("htmlDocument", () => {
  it("wraps a body fragment in a standalone page carrying the title and the inlined notebook CSS", () => {
    const out = htmlDocument("My Page", "<h2>hi</h2>");
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain("<title>My Page</title>");
    expect(out).toContain("<h2>hi</h2>");
    expect(out).toContain(".doc{max-width:52rem"); // DOC_STYLE landed
    expect(out).toContain(":root{"); // NOTEBOOK_CSS landed
    expect(out).toContain("Arcelle · generated on this Mac");
  });

  it("escapes the title", () => {
    const out = htmlDocument("<script>", "<p>x</p>");
    expect(out).toContain("<title>&lt;script&gt;</title>");
  });

  it("passes a whole document through unwrapped, never double-wrapping it", () => {
    const full = "<!doctype html><html><body>already whole</body></html>";
    expect(htmlDocument("ignored", full)).toBe(full);
  });
});
