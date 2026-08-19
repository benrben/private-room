/* How an EPUB's hrefs become zip entry names.
 *
 * An href inside an OPF, an NCX or a chapter is a URI reference, so every
 * space and non-ASCII character in a filename arrives percent-escaped while
 * the zip's entry names are the decoded text. Get the conversion wrong in
 * either direction and the book opens with no chapters at all.
 *
 * `parseEpub` needs a DOMParser, which this runner has no implementation of.
 * `hrefToPath` is the pure step underneath it and runs against the REAL
 * `resolvePath` — the ordering of those two operations is the whole point, so
 * a stub of the resolver would test nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

const transpile = (relPath) =>
  ts.transpileModule(readFileSync(join(root, relPath), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

// A data: URL has no base to resolve `./zipdoc` against, so the dependency is
// inlined as its own data: URL — the real module either way.
const zipdocUrl = `data:text/javascript,${encodeURIComponent(transpile("src/viewers/zipdoc.ts"))}`;
const epubJs = transpile("src/viewers/epub.ts").replaceAll('"./zipdoc"', `"${zipdocUrl}"`);
const { hrefToPath } = await import(`data:text/javascript,${encodeURIComponent(epubJs)}`);

const OPF = "OEBPS/content.opf";

test("an escaped space finds the entry it names", () => {
  // The reported break: the publisher escapes, the zip does not, and every
  // chapter in the spine misses.
  assert.equal(hrefToPath(OPF, "Text/Chapter%201.xhtml"), "OEBPS/Text/Chapter 1.xhtml");
  assert.equal(hrefToPath(OPF, "Text/%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml"), "OEBPS/Text/第一章.xhtml");
});

test("an unescaped href still resolves against the package folder", () => {
  assert.equal(hrefToPath(OPF, "Text/ch1.xhtml"), "OEBPS/Text/ch1.xhtml");
  assert.equal(hrefToPath("OEBPS/Text/ch1.xhtml", "../images/cover.png"), "OEBPS/images/cover.png");
});

test("a fragment is stripped before anything is decoded", () => {
  assert.equal(hrefToPath(OPF, "Text/A%20B.xhtml#ch1"), "OEBPS/Text/A B.xhtml");
  // %23 is part of the filename, not a fragment separator.
  assert.equal(hrefToPath(OPF, "Text/a%23b.xhtml"), "OEBPS/Text/a#b.xhtml");
});

test("an escaped colon does not read as a URL scheme", () => {
  // Decoding before resolving hands the resolver `Notes: one.xhtml`, which is
  // shaped exactly like `mailto:…` — it returns it untouched and the book's
  // folder is gone, so the chapter is never found.
  assert.equal(hrefToPath(OPF, "Notes%3A%20one.xhtml"), "OEBPS/Notes: one.xhtml");
  // A real absolute URL is still left alone.
  assert.equal(hrefToPath(OPF, "https://example.com/a.png"), "https://example.com/a.png");
});

test("an escaped dot-dot stays one path segment", () => {
  assert.equal(hrefToPath(OPF, "%2E%2E/escape.xhtml"), "OEBPS/../escape.xhtml");
  assert.notEqual(hrefToPath(OPF, "%2E%2E/escape.xhtml"), "escape.xhtml");
});

test("a malformed escape keeps the name as written", () => {
  // A stray `%` is not a reason for the book to fail to open.
  assert.equal(hrefToPath(OPF, "Text/100%.xhtml"), "OEBPS/Text/100%.xhtml");
  assert.equal(hrefToPath(OPF, "Text/%zz.xhtml"), "OEBPS/Text/%zz.xhtml");
});
