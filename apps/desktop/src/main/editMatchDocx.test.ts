/**
 * Vitest port of a representative subset of `src-tauri/src/extraction/docx.rs`'s
 * `mod tests` — `edit_match.rs`'s own test module exercises `docx_replace_text`
 * only end-to-end (through `run_edit_file`, ported in `editMatch.test.ts`);
 * THESE pin the algorithm itself (run-splitting, cross-run matches, paragraph
 * boundaries, whitespace tolerance), which this port had to build over a
 * hand-rolled ZIP reader/writer.
 */

import { describe, expect, it } from "vitest";
import { buildZip, readZipEntryText } from "./editMatchZip.js";
import { docxReplaceText, extractDocx, replaceInTextNodes } from "./editMatchDocx.js";
import { extractText } from "./editMatch.js";

/** The JS analogue of `crate::extraction::fake_office_zip`: a minimal
 * Office-style zip with a single entry. */
function fakeOfficeZip(entry: string, xml: string): Buffer {
  return buildZip([{ name: entry, data: Buffer.from(xml, "utf8") }]);
}

// The ported Rust tests read back through `extract_text` (the FULL dispatcher,
// which also normalizes whitespace) rather than calling `extract_docx`
// directly, so these do the same.
describe("extractDocx (through the extractText dispatcher, matching docx.rs's own tests)", () => {
  it("extracts docx paragraphs", () => {
    const bytes = fakeOfficeZip("word/document.xml", "<w:document><w:p><w:t>Hello contract</w:t></w:p></w:document>");
    expect(extractText("contract.docx", bytes)).toContain("Hello contract");
  });

  it("reads headers, footers, footnotes and comments", () => {
    // Only word/document.xml used to be read, so a clause hiding in a footnote
    // (or a header, footer or review comment) was invisible to search and to
    // the assistant, with nothing saying it had been skipped.
    const bytes = buildZip([
      { name: "word/document.xml", data: Buffer.from("<w:p><w:t>The body clause.</w:t></w:p>") },
      { name: "word/footnotes.xml", data: Buffer.from("<w:p><w:t>Subject to the arbitration rider.</w:t></w:p>") },
      { name: "word/header1.xml", data: Buffer.from("<w:p><w:t>CONFIDENTIAL DRAFT</w:t></w:p>") },
      { name: "word/footer1.xml", data: Buffer.from("<w:p><w:t>Page of the agreement</w:t></w:p>") },
      { name: "word/comments.xml", data: Buffer.from("<w:p><w:t>Check this with legal.</w:t></w:p>") },
    ]);
    const text = extractText("contract.docx", bytes)!;
    expect(text).toContain("The body clause.");
    expect(text).toContain("[footnotes]");
    expect(text).toContain("arbitration rider");
    expect(text).toContain("CONFIDENTIAL DRAFT");
    expect(text).toContain("Page of the agreement");
    expect(text).toContain("Check this with legal.");
  });

  it("the raw reader finds the same content, and reports null for a non-docx", () => {
    const bytes = fakeOfficeZip("word/document.xml", "<w:document><w:p><w:t>Hello contract</w:t></w:p></w:document>");
    expect(extractDocx(bytes)).toContain("Hello contract");
    expect(extractDocx(Buffer.from("not a zip"))).toBeNull();
  });
});

describe("replaceInTextNodes", () => {
  it("a NUL in the needle reports not-found instead of matching the paragraph sentinel", () => {
    const xml = "<w:document><w:p><w:t>One</w:t></w:p><w:p><w:t>Two</w:t></w:p></w:document>";
    expect(replaceInTextNodes(xml, `One${String.fromCharCode(0)}Two`, "x").count).toBe(0);
    // A NUL next to text that IS present still edits normally (the fold table
    // drops it; it never blocks a match on its own).
    const second = replaceInTextNodes(xml, `${String.fromCharCode(0)}One`, "Uno");
    expect(second.count).toBe(1);
    expect(second.xml).toContain("Uno");
  });

  it("edits text and round-trips through extractText", () => {
    const xml = '<w:document><w:p><w:t xml:space="preserve">Fee: 5% &amp; costs</w:t></w:p></w:document>';
    const patched = replaceInTextNodes(xml, "5% & costs", "7% & costs");
    expect(patched.count).toBe(1);
    const bytes = buildZip([{ name: "word/document.xml", data: Buffer.from(patched.xml, "utf8") }]);
    const text = extractText("contract.docx", bytes)!;
    expect(text).toContain("7% & costs");
    expect(text).not.toContain("5%");
  });

  it("rejects missing text", () => {
    expect(replaceInTextNodes("<w:document><w:p><w:t>Hello</w:t></w:p></w:document>", "Goodbye", "x").count).toBe(0);
  });

  it("skips non-text tags and counts every match", () => {
    const out = replaceInTextNodes("<w:p><w:tab/><w:t>alpha beta</w:t><w:t>beta</w:t></w:p>", "beta", "gamma");
    expect(out.count).toBe(2);
    expect(out.xml).toContain("alpha gamma");
    expect(out.xml).toContain("<w:tab/>");
  });

  it("keeps scanning valid runs before malformed text markup", () => {
    const xml = '<w:p><w:t>ofﬁ\u200bce</w:t><w:tab/><w:t data-empty="yes"/><w:t broken';
    const out = replaceInTextNodes(xml, "office", "suite");
    expect(out.count).toBe(1);
    expect(out.xml).toContain("suite");
    expect(out.xml).toContain('<w:t data-empty="yes"/>');
    expect(out.xml).toContain("<w:t broken");
  });

  it("keeps parsed runs editable when a later text node is unclosed", () => {
    const xml = "<w:p><w:t>office</w:t><w:t>unfinished";
    const out = replaceInTextNodes(xml, "office", "suite");
    expect(out.count).toBe(1);
    expect(out.xml).toContain("suite");
    expect(out.xml).toContain("<w:t>unfinished");
  });

  it("spans formatting runs (a sentence split across many <w:t> nodes)", () => {
    // Word splits a sentence into many runs (spellcheck, formatting, rsid
    // churn), so a match may span several nodes.
    const xml = "<w:p><w:r><w:t>The fee is 5</w:t></w:r><w:r><w:t>% of </w:t></w:r><w:r><w:t>total revenue</w:t></w:r>.</w:p>";
    const out = replaceInTextNodes(xml, "5% of total", "7% of net");
    expect(out.count).toBe(1);
    const plain = out.xml
      .replace(/<[^>]*>/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    expect(plain).toContain("The fee is 7% of net revenue");
  });

  it("tolerates whitespace differences between the quote and the runs", () => {
    const out = replaceInTextNodes("<w:p><w:t>Payment due within 30 days.</w:t></w:p>", "due  within\n30 days", "due within 45 days");
    expect(out.count).toBe(1);
    expect(out.xml).toContain("due within 45 days");
  });

  it("folds a ligature in the searched text before matching ordinary runs", () => {
    const out = replaceInTextNodes("<w:p><w:t>office</w:t></w:p>", "ofﬁce", "suite");
    expect(out).toEqual({ xml: "<w:p><w:t>suite</w:t></w:p>", count: 1 });
  });

  it("does not match across paragraphs", () => {
    const xml = "<w:p><w:t>end here.</w:t></w:p><w:p><w:t>Next para</w:t></w:p>";
    expect(replaceInTextNodes(xml, "here. Next", "x").count).toBe(0);
  });

  it("folds curly quotes and NBSP across a run boundary", () => {
    const xml = "<w:p><w:r><w:t>the \u{201C}fee\u{201D}\u{00A0}is</w:t></w:r><w:r><w:t> 5% today</w:t></w:r></w:p>";
    const out = replaceInTextNodes(xml, 'the "fee" is 5%', 'the "fee" is 7%');
    expect(out.count).toBe(1);
    const bytes = buildZip([{ name: "word/document.xml", data: Buffer.from(`<w:document>${out.xml}</w:document>`, "utf8") }]);
    const text = extractText("c.docx", bytes)!;
    expect(text).toContain("7% today");
    expect(text).not.toContain("5%");
  });

  it("the replace-all count matches the text branch's", () => {
    expect(replaceInTextNodes("<w:p><w:t>fee is 5% and fee is 5%</w:t></w:p>", "fee is 5%", "fee is 7%").count).toBe(2);
  });

  it("marks preserved whitespace when a replacement leaves edge whitespace", () => {
    // Word trims un-flagged edge whitespace; keep it explicit.
    const out = replaceInTextNodes("<w:p><w:t>ab</w:t><w:t>c</w:t></w:p>", "b", "b and ");
    expect(out.count).toBe(1);
    expect(out.xml).toContain('<w:t xml:space="preserve">ab and </w:t>');
  });
});

describe("docxReplaceText", () => {
  it("reports a file that is not a readable .docx", () => {
    const r = docxReplaceText(Buffer.from("not a zip"), "x", "y");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("not a readable .docx");
    }
  });

  it("reports nothing-matched, naming the searched text", () => {
    const bytes = fakeOfficeZip("word/document.xml", "<w:document><w:p><w:t>Hello</w:t></w:p></w:document>");
    const r = docxReplaceText(bytes, "Goodbye", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("Goodbye");
      expect(r.error).toContain("paragraph break");
    }
  });

  it("keeps every other zip entry's content unchanged", () => {
    const bytes = buildZip([
      { name: "word/document.xml", data: Buffer.from("<w:p><w:t>fee is 5%</w:t></w:p>") },
      { name: "word/styles.xml", data: Buffer.from("<w:styles>keep me</w:styles>") },
    ]);
    const r = docxReplaceText(bytes, "5%", "7%");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(extractText("contract.docx", r.bytes)).toContain("fee is 7%");
      expect(readZipEntryText(r.bytes, "word/styles.xml")).toBe("<w:styles>keep me</w:styles>");
    }
  });
});
