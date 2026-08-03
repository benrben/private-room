/* The script-run consent card's trust sentences (audit finding 64).
 *
 * A script runs with `env_clear()` + HOME=the user's real home and NO sandbox
 * profile (`script_run::execute_script_in_workspace`). The card named the
 * internet and the unencrypted workspace but never the home folder, so
 * approving a "word counter" granted far more than the card described. These
 * assertions are the wording contract; Overlays.tsx renders these constants and
 * nothing else, so the card cannot drift back to the comfortable subset.
 *
 * Runs against the REAL TypeScript source, type-stripped in memory (the trick
 * provenance.test.mjs uses), so there is no compiled copy to drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

async function load(relPath) {
  const source = readFileSync(join(root, relPath), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}

const { SCRIPT_POWERS, SCRIPT_WORKSPACE_NOTE } = await load("src/workspace/scriptTrust.ts");

test("the card names the internet, the missing sandbox and the home folder", () => {
  assert.match(SCRIPT_POWERS, /internet/);
  assert.match(SCRIPT_POWERS, /no sandbox/);
  assert.match(SCRIPT_POWERS, /home folder/);
});

test("the card still names the unencrypted workspace", () => {
  assert.match(SCRIPT_WORKSPACE_NOTE, /outside the room's encryption/);
});

test("Overlays renders the shared sentences rather than its own copy", () => {
  const jsx = readFileSync(join(root, "src/workspace/Overlays.tsx"), "utf8");
  assert.match(jsx, /\{SCRIPT_POWERS\}/);
  assert.match(jsx, /\{SCRIPT_WORKSPACE_NOTE\}/);
  // The old hard-coded sentence must not survive alongside the constants.
  assert.doesNotMatch(jsx, /it can reach the internet\./);
});
