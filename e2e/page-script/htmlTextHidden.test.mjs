/* The visibility rule behind the frame-selection check.
 *
 * A page in the Page tab reports its own selection, and the app verifies the
 * reported passage occurs in the document before offering to quote it. Markup
 * the document hid must not answer that check: a reader cannot select what is
 * not rendered, so a hidden block would let a saved file put words of its own
 * choosing into the composer under the file's name.
 *
 * `textOf` itself needs a DOMParser, which this runner has no implementation
 * of; the predicate it walks with is pure, so that is what runs here. Elements
 * are stood in for by the two methods it reads.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../../src/viewers/htmlText.ts"), "utf8");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { isHiddenMarkup } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

/** An element as this predicate sees one: attributes, nothing else. */
const el = (attrs = {}) => ({
  hasAttribute: (n) => Object.prototype.hasOwnProperty.call(attrs, n),
  getAttribute: (n) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null),
});

test("an element with no styling of its own is visible", () => {
  assert.equal(isHiddenMarkup(el()), false);
  assert.equal(isHiddenMarkup(el({ style: "" })), false);
  assert.equal(isHiddenMarkup(el({ class: "note" })), false);
});

test("the block the exploit hides its sentence in is not visible text", () => {
  assert.equal(isHiddenMarkup(el({ style: "display:none" })), true);
  assert.equal(isHiddenMarkup(el({ style: "display: none;" })), true);
  assert.equal(isHiddenMarkup(el({ style: "COLOR:red;DISPLAY:NONE" })), true);
  assert.equal(isHiddenMarkup(el({ hidden: "" })), true);
  assert.equal(isHiddenMarkup(el({ hidden: "until-found" })), true);
  assert.equal(isHiddenMarkup(el({ style: "visibility:hidden" })), true);
  assert.equal(isHiddenMarkup(el({ style: "visibility : collapse" })), true);
});

test("styling that still renders the words keeps them", () => {
  // Over-reaching here would delete real content from the Text tab, which
  // reads the same walk.
  assert.equal(isHiddenMarkup(el({ style: "display:block" })), false);
  assert.equal(isHiddenMarkup(el({ style: "visibility:visible" })), false);
  assert.equal(isHiddenMarkup(el({ style: "opacity:0.5" })), false);
  assert.equal(isHiddenMarkup(el({ style: "font-size:0.9rem" })), false);
});
