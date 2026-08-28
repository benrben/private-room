/* The focused speech-accuracy gate must run the Python implementation that
 * ships inside the Electron sidecar. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = readFileSync(join(root, "scripts/accuracy-tests.sh"), "utf8");

test("the accuracy script runs the shipping Python sidecar", () => {
  assert.match(script, /cd .*sidecar/);
  assert.match(script, /uv run pytest -q/);
});

test("every focused speech suite named by the script exists", () => {
  const suites = [...script.matchAll(/tests\/(test_[a-z0-9_]+\.py)/g)].map((m) => m[1]);
  assert.ok(suites.length >= 8, "the focused gate lost most of its coverage");
  for (const suite of suites) {
    assert.ok(existsSync(join(root, "services/agent-sidecar/tests", suite)), `missing services/agent-sidecar/tests/${suite}`);
  }
});
