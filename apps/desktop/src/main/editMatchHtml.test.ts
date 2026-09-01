/**
 * Vitest port of `src-tauri/src/extraction/html_edit.rs`'s own `mod tests`
 * plus `extraction/html.rs`'s — `edit_match.rs`'s own test module exercises
 * these only end-to-end (through `run_edit_file`, ported in
 * `editMatch.test.ts`); THESE pin the run-scanning/splicing algorithm itself,
 * which this port had to carry over character by character.
 */

import { describe, expect, it } from "vitest";
import { findSectionRangeHtml, htmlEscape, htmlReplaceText, scanHeadings, scanHtmlRuns, stripHtml } from "./editMatchHtml.js";

/** LATIN CAPITAL LETTER I WITH DOT ABOVE — the one ASCII-adjacent character
 * whose Unicode lowercase is LONGER than itself (`i` + U+0307). */
const DOTTED_I = "\u{0130}";

function replaced(html: string, old: string, newEscaped: string): { html: string; count: number } {
  const r = htmlReplaceText(html, old, newEscaped);
  if (!r.ok) {
    throw new Error(`expected a replacement, got: ${r.error}`);
  }
  return { html: r.html, count: r.count };
}

describe("htmlReplaceText", () => {
  it("replaces text in a single run", () => {
    const r = replaced("<p>Q3 revenue was $4M this year.</p>", "$4M", "$5M");
    expect(r.count).toBe(1);
    expect(r.html).toBe("<p>Q3 revenue was $5M this year.</p>");
  });

  it("never matches inside script or style", () => {
    const html =
      "<html><head><style>p { color: $4M; }</style></head><body>" +
      "<script>var x = '$4M';</script><p>The real $4M is here.</p></body></html>";
    const r = replaced(html, "$4M", "$5M");
    expect(r.count).toBe(1);
    expect(r.html).toContain("color: $4M");
    expect(r.html).toContain("var x = '$4M'");
    expect(r.html).toContain("The real $5M is here");
  });

  it("never matches attribute text", () => {
    const html = '<img src="a.png" alt="Q3 revenue was $4M"><p>Q3 revenue was $4M.</p>';
    const r = replaced(html, "$4M", "$5M");
    expect(r.count).toBe(1);
    expect(r.html).toContain('alt="Q3 revenue was $4M"');
    expect(r.html).toContain("Q3 revenue was $5M.");
  });

  it("splices in the replacement literally — escaping is the caller's job", () => {
    // The caller HTML-escapes before calling; this must never do it a second
    // time, or a legitimately escaped replacement comes out double-escaped.
    const r = replaced("<p>old</p>", "old", "&lt;b&gt;new&lt;/b&gt;");
    expect(r.count).toBe(1);
    expect(r.html).toBe("<p>&lt;b&gt;new&lt;/b&gt;</p>");
  });

  it("matches across entities", () => {
    const r = replaced("<p>Terms &amp; Conditions apply.</p>", "Terms & Conditions", "Rules &amp; Guidelines");
    expect(r.count).toBe(1);
    expect(r.html).toContain("Rules &amp; Guidelines");
  });

  it("replaces a match spanning inline bold", () => {
    // "was $4M this" spans run0's suffix, all of the <strong> run, and run2's
    // prefix. The whole replacement lands in run0 (first run wins);
    // <strong></strong> survives, emptied.
    const r = replaced("<p>Q3 revenue was <strong>$4M</strong> this year.</p>", "was $4M this", "was $5M this");
    expect(r.count).toBe(1);
    expect(r.html).toBe("<p>Q3 revenue was $5M this<strong></strong> year.</p>");
  });

  it("never matches across a paragraph boundary", () => {
    // Same word both sides, back to back, with NOTHING between the closing
    // and opening tags — without the block sentinel, "HelloHello" would read
    // as one contiguous match. It must not.
    const html = "<p>Hello</p><p>Hello</p>";
    const miss = htmlReplaceText(html, "HelloHello", "x");
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.error).toContain("Could not find");
    }
    // Each paragraph's own "Hello" is still independently editable.
    const r = replaced(html, "Hello", "Hi");
    expect(r.count).toBe(2);
    expect(r.html).toBe("<p>Hi</p><p>Hi</p>");
  });

  it("REGRESSION: a doubled slash in a close tag still records the block boundary", () => {
    // `<//p>` is malformed markup, but it is still a `</p>`: the Rust scanner
    // strips EVERY leading slash (`trim_start_matches('/')`) before reading the
    // tag name, so the paragraph boundary is recorded and a quote may not cross
    // it. This port stripped only the FIRST slash, so the name came out empty,
    // no boundary was recorded, and "HelloWorld" matched straight across —
    // fusing two block elements and DELETING the second one's text, reported as
    // a clean single replacement. Verified against the Rust source, which
    // refuses this exact input.
    const html = "<div>Hello<//p>World</div>";
    const miss = htmlReplaceText(html, "HelloWorld", "x");
    expect(miss.ok).toBe(false);
    // Each side is still independently editable, and the markup survives.
    expect(replaced(html, "World", "Earth").html).toBe("<div>Hello<//p>Earth</div>");
  });

  it("a close tag whose name is followed by a space or slash is still a block close", () => {
    // `</p >` and `</p/>`: the name ends at the first whitespace-or-slash, so
    // both name to `p` and both raise the boundary (parity with Rust).
    expect(htmlReplaceText("<div>Hello</p >World</div>", "HelloWorld", "x").ok).toBe(false);
    expect(htmlReplaceText("<div>Hello</p/>World</div>", "HelloWorld", "x").ok).toBe(false);
  });

  it("trims Unicode whitespace before a malformed block close tag", () => {
    // The scanner follows Rust's Unicode `trim_start`, so even a malformed
    // `< EM SPACE /p>` boundary cannot let a quote cross from A into B.
    expect(htmlReplaceText("<div>A< \u2003/p>B</div>", "AB", "x").ok).toBe(false);
  });

  it("a match starting on a ligature's second half rewrites the WHOLE ligature", () => {
    // A CHARACTERIZATION test, pinned deliberately. `foldEditChar` expands
    // U+FB01 to `f` + `i` and maps BOTH halves to the same source character, so
    // a quote of "inal draft" resolves to a span covering the whole `ﬁ` and the
    // `f` disappears with it. The plain-text matcher REFUSES this (see
    // `splitsALigature` in editMatchFuzzy.ts); the HTML and docx run matchers
    // have no such guard — in the Rust source either, which was checked
    // directly against `html_edit::html_replace_text` for this exact input.
    // Pinned so the asymmetry is visible and a future change to it is a
    // deliberate one rather than a silent drift away from the Rust behaviour.
    const r = replaced("<p>xxxxxthe \u{FB01}nal draft</p>", "inal draft", "x");
    expect(r.count).toBe(1);
    expect(r.html).toBe("<p>xxxxxthe x</p>");
  });

  it("a cross-run match lands in the first run and clears the rest", () => {
    // "total up" spans three runs joined by inline tags. The whole replacement
    // lands in the FIRST run (keeping its <b> formatting); the matched
    // remainder in later runs is cleared, leaving <i></i> empty rather than
    // deleting the tag itself.
    const r = replaced("<p>Revenue: <b>total</b> <i>up</i> this year.</p>", "total up", "sum higher");
    expect(r.count).toBe(1);
    expect(r.html).toBe("<p>Revenue: <b>sum higher</b><i></i> this year.</p>");
  });

  it("replaces every occurrence unconditionally — ambiguity is the caller's job", () => {
    const r = replaced("<p>total is $4M</p><p>total is $4M</p>", "$4M", "$5M");
    expect(r.count).toBe(2);
    expect(r.html.match(/\$5M/g)?.length).toBe(2);
  });

  it("survives malformed markup (an unterminated tag)", () => {
    expect(() => htmlReplaceText("<p>Hello <b>world", "Hello", "Hi")).not.toThrow();
  });

  it("survives an unterminated script tag", () => {
    const r = replaced("<p>Keep me.</p><script>var x = 1;", "Keep me", "Kept");
    expect(r.html).toBe("<p>Kept.</p><script>var x = 1;");
  });

  it("is idempotent: edit then revert is byte-identical", () => {
    const html = "<p>Q3 revenue was $4M this year.</p>";
    const once = replaced(html, "$4M", "$5M").html;
    expect(replaced(once, "$5M", "$4M").html).toBe(html);
  });

  it("tolerates curly quotes like the text and docx matchers", () => {
    const r = replaced("<p>She said \u{201C}hello\u{201D} to me.</p>", '"hello"', '"goodbye"');
    expect(r.count).toBe(1);
    expect(r.html).toContain("goodbye");
  });

  it("an empty quote is refused rather than matching everywhere", () => {
    const miss = htmlReplaceText("<p>anything</p>", "   ", "x");
    expect(miss.ok).toBe(false);
  });

  it("reports a normal no-match when the quote cannot fit in the readable text", () => {
    const miss = htmlReplaceText("<p>x</p>", "a much longer quote", "x");
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.error).toContain("exact text");
    }
  });

  it("normalizes folded ligatures and trailing whitespace before matching", () => {
    expect(replaced("<p>fi</p>", "\u{FB01}", "x").html).toBe("<p>x</p>");
    expect(replaced("<p>word </p>", "word ", "x").html).toBe("<p>x </p>");
  });
});

describe("scanHtmlRuns", () => {
  it("keeps a script body out of the runs even when it holds a length-changing uppercase letter", () => {
    // REGRESSION: the close-tag search must use an ASCII fold. A Unicode
    // `toLowerCase()` expands U+0130 to TWO code units, so an index found in
    // the lowered copy no longer addresses the original — the scanner then
    // resumed at the wrong offset and mis-attributed the page's text.
    const html = `<style>${DOTTED_I.repeat(10)}</style><p>the target here</p>`;
    const runs = scanHtmlRuns(html).runs.map((r) => r.chars.join(""));
    expect(runs).toEqual(["the target here"]);
  });

  it("keeps numeric entities but treats invalid and overlong entities as literal source text", () => {
    const html = "<p>&#x1F600; &#128512; &#xD800; &unknown; &this_entity_name_is_far_too_long_to_decode;</p>";
    expect(scanHtmlRuns(html).runs.map((run) => run.chars.join(""))).toEqual([
      "😀 😀 &#xD800; &unknown; &this_entity_name_is_far_too_long_to_decode;",
    ]);
  });

  it("stops safely at malformed comments, tags, and non-content elements", () => {
    expect(scanHtmlRuns("<p>keep</p><!-- unfinished").runs.map((run) => run.chars.join(""))).toEqual(["keep"]);
    expect(scanHtmlRuns("<p>keep</p><style>unfinished").runs.map((run) => run.chars.join(""))).toEqual(["keep"]);
    expect(scanHtmlRuns("<p>keep</p><style").runs.map((run) => run.chars.join(""))).toEqual(["keep"]);
    expect(scanHtmlRuns("<p>keep</p><unfinished").runs.map((run) => run.chars.join(""))).toEqual(["keep"]);
  });
});

describe("scanHeadings / findSectionRangeHtml", () => {
  it("reads heading level and decoded text, including inline markup", () => {
    const headings = scanHeadings("<h1>Intro</h1><p>a</p><h2>Setup <em>and</em> Config</h2><p>b</p>");
    expect(headings.length).toBe(2);
    expect(headings[0]!.level).toBe(1);
    expect(headings[0]!.text).toBe("Intro");
    expect(headings[1]!.level).toBe(2);
    expect(headings[1]!.text).toBe("Setup and Config");
  });

  it("a section runs to the next same-or-higher heading", () => {
    const html = "<h1>A</h1><p>a-body</p><h2>A.1</h2><p>a1-body</p><h1>B</h1><p>b-body</p>";
    // Section "A" (h1) ends at the next h1 ("B"), so it swallows the h2
    // sub-section too — a sub-heading doesn't end its parent's section.
    const range = findSectionRangeHtml(html, "A");
    if (!range.ok) {
      throw new Error("expected a range");
    }
    const section = html.slice(range.start, range.end);
    expect(section).toContain("a-body");
    expect(section).toContain("A.1");
    expect(section).toContain("a1-body");
    expect(section).not.toContain("b-body");

    const sub = findSectionRangeHtml(html, "A.1");
    if (!sub.ok) {
      throw new Error("expected a range");
    }
    const subText = html.slice(sub.start, sub.end);
    expect(subText).toContain("a1-body");
    expect(subText).not.toContain("b-body");
  });

  it("an unknown section lists the real headings found", () => {
    const miss = findSectionRangeHtml("<h1>Intro</h1><p>a</p><h2>Setup</h2><p>b</p>", "Nonexistent");
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      expect(miss.headings).toEqual(["Intro", "Setup"]);
    }
  });

  it("the last section runs to the end of the document", () => {
    const html = "<h1>Only</h1><p>only-body</p>";
    const range = findSectionRangeHtml(html, "Only");
    if (!range.ok) {
      throw new Error("expected a range");
    }
    expect(html.slice(range.start, range.end)).toBe("<p>only-body</p>");
  });

  it("a heading's text stops at its OWN closing tag even after a length-changing uppercase letter", () => {
    // REGRESSION: with a Unicode `toLowerCase()` the `</h1>` search returned
    // an index into the LOWERED copy; applied to the original it pointed past
    // the real close tag, so the heading swallowed the paragraph after it and
    // `section` then scoped an edit to the wrong byte range (or reported a
    // real heading as missing).
    const prefix = DOTTED_I.repeat(10);
    const html = `<h1>${prefix} Q1</h1><p>a</p><h1>Q2</h1><p>total is 5</p>`;
    expect(scanHeadings(html).map((h) => h.text)).toEqual([`${prefix} Q1`, "Q2"]);
    const range = findSectionRangeHtml(html, `${prefix} Q1`);
    if (!range.ok) {
      throw new Error("the first heading must still be findable");
    }
    expect(html.slice(range.start, range.end)).toBe("<p>a</p>");
  });

  it("retains already-read headings before malformed comment or tag tails", () => {
    expect(scanHeadings("<h1>Keep</h1><!-- unfinished").map((heading) => heading.text)).toEqual(["Keep"]);
    expect(scanHeadings("<h1>Keep</h1><h2").map((heading) => heading.text)).toEqual(["Keep"]);
    expect(scanHeadings("<h1>missing close")).toEqual([]);
    expect(scanHeadings("<h1>missing close</h1")).toEqual([]);
  });
});

describe("stripHtml", () => {
  it("survives a length-changing uppercase fold (Turkish İ)", () => {
    const html = `<div>${DOTTED_I.repeat(4)}</div><main>${DOTTED_I}stanbul body</main><footer>${DOTTED_I} chrome</footer>`;
    const out = stripHtml(html);
    expect(out).toContain(`${DOTTED_I}stanbul body`);
    expect(out).not.toContain("chrome");
  });

  it("keeps a malformed page whole when the close tag precedes the open tag", () => {
    const out = stripHtml("</article><p>orphan text</p><article>tail");
    expect(out).toContain("orphan text");
    expect(out).toContain("tail");
  });

  it("drops chrome elements case-insensitively", () => {
    const out = stripHtml("<BODY><NAV>menu</NAV><p>keep me</p><SCRIPT>var x=1;</SCRIPT></BODY>");
    expect(out).toContain("keep me");
    expect(out).not.toContain("menu");
    expect(out).not.toContain("var x");
  });

  it("does not discard readable text after an unclosed chrome element", () => {
    // An unclosed tag has no safe close offset. The stripping pipeline must
    // leave it for tag removal rather than swallow the document tail.
    expect(stripHtml("<p>keep</p><nav>tail without a close")).toContain("tail without a close");
  });
});

describe("htmlEscape", () => {
  it("escapes the four HTML-significant characters, ampersand first", () => {
    expect(htmlEscape('A & B <script> "quoted"')).toBe("A &amp; B &lt;script&gt; &quot;quoted&quot;");
  });
});
