/* Reading a selection out of a sandboxed document frame.
 *
 * Everything this module parses arrives from a document the app does not
 * trust, over a channel that untrusted script can post to freely. So what is
 * pinned here is the paranoia: a message is only a selection report if it says
 * so, carries a string, and carries numbers that are actually numbers.
 *
 * The other half of the rule — that the reported passage must really occur in
 * the document — lives in quoteSelection.ts and is pinned in its own suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const SOURCE = readFileSync(join(root, "apps/desktop/src/renderer/viewers/frameSelection.ts"), "utf8");

const js = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { frameSelectionOf, withSelectionReporter } = await import(
  `data:text/javascript,${encodeURIComponent(js)}`
);

/** What the injected reporter actually sends. */
const report = (over = {}) => ({
  mark: "arcelle:frame-selection",
  text: "the rent is due on the first",
  rect: { top: 100, left: 40, width: 220 },
  ...over,
});

test("a well-formed report is read", () => {
  const out = frameSelectionOf(report());
  assert.equal(out.text, "the rent is due on the first");
  assert.deepEqual(out.rect, { top: 100, left: 40, width: 220 });
});

test("ordinary page chatter to the parent is not a selection", () => {
  // Pages postMessage to their embedder for their own reasons. None of it may
  // be mistaken for the user pointing at a passage.
  assert.equal(frameSelectionOf({ text: "hello", rect: { top: 1, left: 1, width: 1 } }), null);
  assert.equal(frameSelectionOf({ mark: "something-else", text: "hello" }), null);
  assert.equal(frameSelectionOf("arcelle:frame-selection"), null);
  assert.equal(frameSelectionOf(null), null);
  assert.equal(frameSelectionOf(undefined), null);
  assert.equal(frameSelectionOf(42), null);
});

test("a report whose text is not text is refused", () => {
  assert.equal(frameSelectionOf(report({ text: { toString: "not a string" } })), null);
  assert.equal(frameSelectionOf(report({ text: 12 })), null);
  assert.equal(frameSelectionOf(report({ text: undefined })), null);
});

test("a rect that is not numbers is dropped, not trusted", () => {
  // A hostile page could offer NaN or Infinity to push the button somewhere
  // absurd. Losing the rect costs the button its position, which is the safe
  // failure; using the value is not.
  for (const bad of [
    { top: NaN, left: 0, width: 10 },
    { top: 0, left: Infinity, width: 10 },
    { top: 0, left: 0, width: "220" },
    { top: 0, left: 0 },
    null,
    "over there",
  ]) {
    const out = frameSelectionOf(report({ rect: bad }));
    assert.ok(out, "the text still parses");
    assert.equal(out.rect, null, `rect ${JSON.stringify(bad)} must not be trusted`);
  }
});

test("an enormous report is cut before the app holds it", () => {
  const out = frameSelectionOf(report({ text: "x".repeat(500_000) }));
  assert.ok(out.text.length <= 8000, `held ${out.text.length} characters`);
});

test("the reporter is added without displacing the document", () => {
  const page = "<html><body><p>hello</p></body></html>";
  const out = withSelectionReporter(page);
  assert.ok(out.startsWith(page), "the page's own markup is untouched and still first");
  assert.ok(out.includes("selectionchange"), "the reporter listens for selection");
  assert.ok(out.includes("arcelle:frame-selection"), "and names what it sends");
});
