/* The file header's run control must not promise what the gate will refuse.
 *
 * `run_script_inner` refuses content whose hash is not approved on this Mac and
 * raises the consent card instead. The Scripts page says so in its button —
 * "Review script", not "Run" — because a button that promised execution made the
 * review gate read as broken (reported twice in live QA). The viewer's header
 * offers the SAME action on the same file and went on saying "Run".
 *
 * There is no renderer in this repo to mount ViewerPane with, so this is a
 * cross-file coupling check in the shape voiceChunker.test.mjs uses for the
 * Rust/TS wording: the label is taken from ScriptRow, which owns the rule, and
 * looked for in the viewer — reword one and this says the two have drifted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const read = (p) => readFileSync(join(root, p), "utf8");

const ROW = read("apps/desktop/src/renderer/workspace/scripts/ScriptRow.tsx");
const VIEWER = read("apps/desktop/src/renderer/workspace/ViewerPane.tsx");

test("the viewer's run button uses the Scripts page's own unapproved label", () => {
  const label = ROW.match(/approved \? "Run" : "([^"]+)"/);
  assert.ok(label, "expected ScriptRow to label its run button off `approved`");

  const at = VIEWER.indexOf("isScriptName(openFile.content.name)");
  assert.ok(at > 0, "expected the header's script button in ViewerPane");
  // Just this control: from the kind test that draws it to the end of its IIFE.
  const to = VIEWER.indexOf("})()}", at);
  assert.ok(to > at, "expected the script button to close its own block");
  const block = VIEWER.slice(at, to);
  assert.ok(
    block.includes(label[1]),
    `the header's run button never says "${label[1]}" — an unapproved script cannot run, ` +
      "so a button labelled Run promises what the consent gate will refuse",
  );
  assert.match(
    block,
    /approved\s*\?/,
    "the label and its tooltip must be decided by the approval state, not fixed",
  );
});
