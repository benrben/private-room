/* Which DRAG counts as pointing at the document (src/workspace/viewerQuote.ts).
 *
 * `quoteSelection.test.mjs` pins what may be quoted once a selection has been
 * accepted; this pins the step before it — the guard that decides whether the
 * selection belongs to the document at all. It had asked BOTH ends whether they
 * were inside the document but only ONE end whether it was inside the reader's
 * own chrome, so a drag that ended in a book's contents list or on a mode button
 * was offered as a quote of the document while the same drag made backwards was
 * refused: the answer depended on the direction of the drag.
 *
 * The guard's pure declarations are lifted from their owning module and run
 * against fake selections, the localModel.test.mjs / voiceChunker.test.mjs idiom.
 * The predicates they call are stubbed; the selection and frame decisions are
 * shipped code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const SOURCE = readFileSync(join(root, "apps/desktop/src/renderer/workspace/viewerQuote.ts"), "utf8");
const SOURCE_TREE = ts.createSourceFile(
  "viewerQuote.ts",
  SOURCE,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function functionSource(name) {
  const declaration = SOURCE_TREE.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.ok(declaration, `${name} is gone from viewerQuote.ts`);
  return declaration.getText(SOURCE_TREE);
}

const DOCUMENT_QUOTE_SOURCE = [
  "selectionCanBeQuoted",
  "quoteSelectionText",
  "quoteSelectionPosition",
  "activeDocumentSelection",
  "readDocumentQuote",
].map(functionSource).join("\n");

/* The document/chrome predicates are DOM containment (`closest`), tested where
 * they live; here a node is just a label, so a test can say where each end of
 * the drag landed. */
const harness = `
let selection = null;
let quote = null;
const window = { getSelection: () => selection };
const kind = "book";
const editMode = false;
const inQuotableDocument = (node) => node === "document" || node === "chrome";
const inExcludedSurface = (node) => node === "chrome";
const quotableText = (text) => text.trim() || null;
`;
const exports = `
export function drag(anchorNode, focusNode, text = "a sentence of the document") {
  quote = null;
  selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode,
    focusNode,
    toString: () => text,
    getRangeAt: () => ({ getBoundingClientRect: () => ({ top: 10, left: 20, width: 100, height: 14 }) }),
  };
  quote = readDocumentQuote(kind, editMode);
  return quote;
}
export function nothingSelected() {
  quote = { text: "stale", top: 0, left: 0 };
  selection = { isCollapsed: true, rangeCount: 0, anchorNode: "document", focusNode: "document" };
  quote = readDocumentQuote(kind, editMode);
  return quote;
}
`;
const js = ts.transpileModule(harness + DOCUMENT_QUOTE_SOURCE + exports, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { drag, nothingSelected } = await import(
  `data:text/javascript,${encodeURIComponent(js)}`
);

/* ---- the same gesture from inside a sandboxed frame ----------------------
 *
 * A saved page reports its own selection, so the passage is a CLAIM: it is
 * offered only if it occurs in the copy of the page the app holds. That copy was
 * cached by file id alone, and the id does not change when the page is rewritten
 * in place or when the encoding picker re-decodes it — so the claim was checked
 * against a document the reader is no longer looking at, and the button silently
 * never appeared. The verification itself is stubbed here (it has its own tests
 * in quoteSelection.test.mjs); what runs for real is WHICH text gets verified. */

const FRAME_QUOTE_SOURCE = [
  "visibleQuoteFrame",
  "frameSourceText",
  "searchableFrameDocument",
  "reportedQuoteFrame",
  "frameQuoteFromMessage",
].map(functionSource).join("\n");

const FRAME_WINDOW = { name: "the page's frame" };
const frameHarness = `
let quote = null;
let parses = 0;
let file = { id: "f1", content: { kind: "html", text: "" } };
let shownFor = "f1";
let shownText = null;
const searchable = { current: null };
const frameSelectionOf = (data) => data;
const inQuotableDocument = () => true;
const textOf = (html) => html;
const searchableDocument = (text) => { parses += 1; return { text }; };
const verifiedFrameQuote = (passage, doc) => (doc.text.includes(passage) ? passage : null);
const frameEl = {
  hidden: false,
  contentWindow: null,
  getBoundingClientRect: () => ({ top: 0, left: 0 }),
};
const document = { querySelectorAll: () => [frameEl] };
`;
const frameExports = `
export function openPage(id, text) { file = { id, content: { kind: "html", text } }; shownFor = id; shownText = null; }
export function rewritePage(text) { file = { id: file.id, content: { kind: "html", text } }; }
export function overrideEncoding(text) { shownText = text; }
export function useFrameWindow(w) { frameEl.contentWindow = w; }
export function reportSelection(text) {
  quote = null;
  quote = frameQuoteFromMessage(
    { data: { text, rect: { top: 4, left: 6, width: 40 } }, source: frameEl.contentWindow },
    file,
    searchable,
    shownFor,
    shownText,
    false,
  );
  return quote;
}
export function parseCount() { return parses; }
`;
const frameJS = ts.transpileModule(
  frameHarness + FRAME_QUOTE_SOURCE + frameExports,
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
).outputText;
const frame = await import(`data:text/javascript,${encodeURIComponent(frameJS)}`);
frame.useFrameWindow(FRAME_WINDOW);

test("a page rewritten while it stays open is checked against what it says NOW", () => {
  frame.openPage("f1", "The deposit is due on the first.");
  assert.ok(frame.reportSelection("The deposit is due on the first."), "the page as saved quotes");
  // Edit → Save reloads the viewer with the SAME file id.
  frame.rewritePage("The deposit is due on the first.\nThe keys are collected on the tenth.");
  assert.ok(
    frame.reportSelection("The keys are collected on the tenth."),
    "a sentence added by the edit must be quotable, not checked against the pre-edit page",
  );
  assert.equal(
    frame.reportSelection("The deposit is due on the second."),
    null,
    "a sentence the page does not contain is still refused",
  );
});

test("an encoding override is what the passage is checked against", () => {
  // The picker re-reads the ORIGINAL BYTES in Rust and the frame renders that
  // reading; verifying against the decode `get_file_content` guessed refused
  // every selection with a non-ASCII character in it, and never healed.
  frame.openPage("f2", "×”×—×•×–×” × ×—×ª× ×'×™× ×•××¨.");
  frame.overrideEncoding("החוזה נחתם בינואר.");
  assert.ok(
    frame.reportSelection("החוזה נחתם בינואר."),
    "the quote is verified against the text the reader is actually showing",
  );
});

test("the page's text is parsed once and reused until it changes", () => {
  frame.openPage("f3", "One sentence only.");
  const before = frame.parseCount();
  frame.reportSelection("One sentence only.");
  frame.reportSelection("One sentence only.");
  assert.equal(frame.parseCount(), before + 1, "a full parse per selection would be the cost this cache exists to avoid");
});

test("a drag inside the document is a quote", () => {
  const q = drag("document", "document");
  assert.ok(q, "a selection wholly inside the document offers the button");
  assert.equal(q.text, "a sentence of the document");
});

test("the reader's own chrome is refused at EITHER end of the drag", () => {
  // The book reader draws its contents list and its mode buttons inside the
  // same scroll region as the text, so containment alone reads a chapter title
  // as document prose. Ending the drag there is exactly as wrong as starting
  // there — and used to be accepted.
  assert.equal(drag("chrome", "document"), null, "a drag that STARTS in the chrome is refused");
  assert.equal(drag("document", "chrome"), null, "a drag that ENDS in the chrome is refused too");
  assert.equal(drag("chrome", "chrome"), null);
});

test("a drag that leaves the document entirely is not a quote of it", () => {
  assert.equal(drag("document", "elsewhere"), null);
  assert.equal(drag("elsewhere", "document"), null);
});

test("an empty or collapsed selection clears the button", () => {
  assert.equal(drag("document", "document", "   "), null, "whitespace is a stray click");
  assert.equal(nothingSelected(), null, "a collapsed selection takes the old button away");
});
