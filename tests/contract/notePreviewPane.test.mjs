/* PREVIEW MUST HIDE THE NOTE EDITOR WITHOUT TAKING ITS SIZE AWAY.
 *
 * Two bugs, one pane, and the fix for the first caused the second.
 *
 *   1. Preview UNMOUNTED the editor. Monaco holds the only editable copy of
 *      unsaved text, so Source → Preview → Source came back to the file as
 *      last saved; worse, CodeEditor hands back `registerSave(null)` and
 *      `onDirtyChange(false)` on the way out, so ⌘S and the unsaved-edits
 *      prompt went quiet on a note that still had work in it.
 *
 *   2. Keeping it mounted under `display: none` gave Monaco a 0×0 box. Live QA:
 *      "all paragraph lines collapsed into a single garbled, overlapping,
 *      unreadable line", which cleared only on save. Nothing was lost — the
 *      preview kept painting the same buffer correctly — but the editor was
 *      unreadable, which for an editor is the same thing.
 *
 * So the pane stays mounted AND keeps a real box. Neither half is visible in a
 * diff of the other file, and the CSS has no test of its own, so both are
 * asserted here. The needles are built rather than written out, so that this
 * file cannot satisfy its own greps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const TSX = read("apps/desktop/src/renderer/viewers/MarkdownEditor.tsx");
const CSS = read("apps/desktop/src/renderer/viewers/markdowneditor.css");

/** The declarations of one rule, by selector. */
function ruleBody(css, selector) {
  const at = css.indexOf(selector);
  assert.notEqual(at, -1, `the \`${selector}\` rule is gone`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

const SOURCE_IN_PREVIEW = '.mde[data-layout="preview"] .mde-source';

test("the editor is mounted in every layout, preview included", () => {
  // The preview pane may come and go; the source pane may not. A layout test
  // around the CodeEditor is the unmount this is here to prevent.
  const panes = TSX.slice(TSX.indexOf('className="mde-panes"'));
  const editor = panes.indexOf("<CodeEditor");
  const preview = panes.indexOf('className="mde-preview"');
  assert.ok(editor > 0 && preview > editor, "the panes are not in source-then-preview order");
  assert.ok(
    !panes.slice(0, editor).includes("layout " + "!== "),
    "the editor is behind a layout test again — Preview would take the buffer with it",
  );
  assert.ok(
    panes.slice(editor, preview).includes("registerSave={registerSave}") &&
      panes.slice(editor, preview).includes("onDirtyChange={onDirtyChange}"),
    "the editor no longer carries the save and dirty channels the two doors need",
  );
});

test("hiding the editor for Preview leaves it a box to measure", () => {
  const body = ruleBody(CSS, SOURCE_IN_PREVIEW);
  // `display: none` is the one way of hiding it that Monaco cannot survive:
  // `automaticLayout` watches the container, and a container with no size
  // lays the buffer out with no size.
  assert.ok(
    !body.includes("display" + ": none"),
    "the source pane is display:none in Preview — Monaco lays out into 0×0 and \
the text comes back overlapping itself",
  );
  // Out of flow so the preview still gets the whole width, but stretched to
  // the pane it left, so the box it reports is the one it will come back to.
  assert.match(body, /position:\s*absolute/);
  assert.match(body, /inset:\s*0/);
  // Not painted, not clickable, not a tab stop, not read aloud.
  assert.match(body, /visibility:\s*hidden/);
  assert.match(body, /pointer-events:\s*none/);
  // An absolutely positioned child needs a positioned ancestor, or `inset: 0`
  // resolves against the page and the editor is laid out at window size.
  assert.match(ruleBody(CSS, ".mde-panes {"), /position:\s*relative/);
});
