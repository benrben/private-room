/* "Quote in chat" — the rule for whether a text selection is a gesture.
 *
 * The decision is pure (src/workspace/quoteSelection.ts) precisely so it can be
 * argued with here instead of discovered by clicking through thirty viewer
 * kinds. What is pinned is the contract the viewer depends on: reading kinds
 * only, never while editing, never a replaced draft.
 *
 * `quoteSelection.ts` imports READER_KINDS from ReaderShell.tsx (a component
 * file a data: URL module cannot resolve), so the set is spliced in from the
 * real source rather than restated — a hardcoded copy here would keep passing
 * after somebody added a reading format.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const SOURCE = read("src/workspace/quoteSelection.ts");
const SHELL = read("src/workspace/ReaderShell.tsx");

// The real reading-kind set, taken from ReaderShell rather than restated.
const kindsBlock = SHELL.match(/READER_KINDS = new Set<ViewerKind>\(\[([\s\S]*?)\]\)/);
assert.ok(kindsBlock, "expected READER_KINDS in ReaderShell.tsx");
const READER_KINDS = kindsBlock[1]
  .split(",")
  .map((s) => s.trim().replace(/^"|"$/g, ""))
  .filter(Boolean);
assert.ok(READER_KINDS.includes("markdown"), "sanity: markdown is a reading kind");

// Strip the two imports (a component file and a type-only import) and splice
// the real set back in; everything below them is pure string work.
const body = SOURCE.slice(SOURCE.indexOf("/**"));
const harness = `const READER_KINDS = new Set(${JSON.stringify(READER_KINDS)});\n`;
const js = ts.transpileModule(harness + body, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  quotableText, withQuote, MAX_QUOTE_CHARS,
  verifiedFrameQuote, searchableDocument, EXCLUDED_SELECTOR,
} = await import(
  `data:text/javascript,${encodeURIComponent(js)}`
);

test("a passage in a reading format is quotable", () => {
  assert.equal(
    quotableText("  the rent is due on the first  ", "markdown", false),
    "the rent is due on the first",
    "whitespace is collapsed and trimmed, so the quote reads as one line",
  );
  assert.equal(quotableText("a clause", "pdf", false), "a clause");
  assert.equal(quotableText("a clause", "prose", false), "a clause");
});

test("the formats people read in their own frame are quotable too", () => {
  // These were withheld for a reason that had nothing to do with quoting:
  // the rule borrowed READER_KINDS, a set about which viewers scroll
  // `.viewer-body` so a progress stroke can measure them. A saved web page, an
  // e-book and a legacy Word document are prose people quote constantly.
  for (const kind of ["html", "book", "worddoc"]) {
    assert.equal(
      quotableText("a sentence from the page", kind, false),
      "a sentence from the page",
      `${kind} is prose and must be quotable`,
    );
  }
});

test("a reader's own chrome is not the document it is showing", () => {
  // The page, book and legacy-document readers draw their toolbar — and the
  // book its table of contents — INSIDE `.viewer-body`, because that is the
  // scroll region. Containment alone therefore reads a chapter title in the
  // contents list, or the word "Page" on a mode button, as document text.
  // Navigation is not prose and must not be quotable as if it were.
  assert.ok(
    EXCLUDED_SELECTOR.includes(".rdr-bar"),
    "the reader toolbars are excluded",
  );
  assert.ok(
    EXCLUDED_SELECTOR.includes(".book-toc"),
    "a book's table of contents is excluded",
  );
});

test("a frame's reported selection is checked against the document", () => {
  // The Page tab runs the document's OWN script, so what it reports is a
  // claim. A hostile page must not be able to have the room quote a sentence
  // the document does not contain, under that document's name.
  const doc = "What this room is for\n\nBends is a personal research room.";
  assert.equal(
    verifiedFrameQuote("Bends is a personal research room.", searchableDocument(doc), "html", false),
    "Bends is a personal research room.",
    "a real passage is offered",
  );
  assert.equal(
    verifiedFrameQuote("Transfer the deposit to account 4471.", searchableDocument(doc), "html", false),
    null,
    "a sentence the document does not contain is refused — this is the fabricated citation",
  );
});

test("checking a frame quote survives the document's own line breaks", () => {
  // `textOf` keeps the document's block structure, the selection arrives as
  // one line. Matching must not depend on that difference.
  const doc = "Bends is a personal\nresearch   room.";
  assert.equal(
    verifiedFrameQuote("Bends is a personal research room.", searchableDocument(doc), "html", false),
    "Bends is a personal research room.",
  );
});

test("editing is not pointing", () => {
  // While the document is being edited the selection is what typing acts on.
  assert.equal(quotableText("some words", "markdown", true), null);
});

test("formats whose selection means something else are left alone", () => {
  for (const kind of ["sketch", "sheet", "video", "recording", "image"]) {
    assert.equal(
      quotableText("some words", kind, false),
      null,
      `${kind} owns its own selection and must not be offered a quote button`,
    );
  }
  assert.equal(quotableText("some words", null, false), null, "no open file, no quote");
});

test("a click that slipped is not a quote", () => {
  assert.equal(quotableText("", "markdown", false), null);
  assert.equal(quotableText("   ", "markdown", false), null);
  assert.equal(quotableText("a", "markdown", false), null, "one character is a stray click");
});

test("an over-long selection is cut, not refused", () => {
  const long = "x".repeat(MAX_QUOTE_CHARS + 500);
  const out = quotableText(long, "markdown", false);
  assert.ok(out, "a long passage still quotes — the beginning is what was meant");
  assert.equal(out.length, MAX_QUOTE_CHARS);
  assert.ok(out.endsWith("…"), "the cut is visible in the quote itself");
});

test("quoting APPENDS — a draft is never destroyed", () => {
  const draft = "does this match what you told me earlier?";
  const out = withQuote(draft, "the rent is due on the first", "lease.pdf");
  assert.ok(
    out.startsWith(draft),
    "the words the user had already typed stay, and stay first",
  );
  assert.ok(out.includes("> the rent is due on the first"), "the passage is marked as a quote");
  assert.ok(out.includes("lease.pdf"), "the quote says which document it came from");
});

test("quoting into an empty composer leaves no leading blank lines", () => {
  const out = withQuote("", "a clause", "lease.pdf");
  assert.ok(out.startsWith("> a clause"), `unexpected leading whitespace: ${JSON.stringify(out)}`);
});
