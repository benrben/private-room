/* What the step editor seeds when you switch a step's kind.
 *
 * These run under `npm run test:page` (node --test) and exercise the REAL
 * `src/workspace/workflows/kinds.ts`, type-stripped in memory with the
 * `typescript` dev dependency — the same recipe address.test.mjs uses. The
 * point is the KEYS: a key the engine's own variant does not declare parses
 * fine (serde ignores unknown ones) and is therefore invisible, so only a test
 * can notice it being written into every saved workflow file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const load = (rel) => {
  const src = readFileSync(join(here, rel), "utf8");
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
};

const { KIND_DEFAULTS, KIND_LABELS } = await load("../../src/workspace/workflows/kinds.ts");
const WORKFLOW_HOST = readFileSync(
  join(here, "../../electron-migration/electron-app/electron/main/workflowModel.ts"),
  "utf8",
);

test("a condition step is seeded with op and value only", () => {
  // `input` was dropped from the Rust `Condition` variant; the editor kept
  // writing `input: ""` into every new condition step, so every workflow file
  // saved since carried a key nothing reads.
  assert.deepEqual(Object.keys(KIND_DEFAULTS.condition).sort(), ["op", "value"]);
  assert.equal("input" in KIND_DEFAULTS.condition, false);
});

test("the engine's Condition variant really has no input field", () => {
  // The claim above is only worth something if the Rust side still agrees.
  const variant = WORKFLOW_HOST.slice(
    WORKFLOW_HOST.indexOf('{ kind: "condition"'),
    WORKFLOW_HOST.indexOf('{ kind: "condition"') + 100,
  );
  assert.ok(variant.includes("op: string"), variant);
  assert.equal(/\binput\s*:/.test(variant), false, variant);
});

test("every kind the palette offers can be seeded", () => {
  // A kind with no defaults row switches into a step serde cannot parse.
  for (const kind of Object.keys(KIND_LABELS)) {
    assert.ok(KIND_DEFAULTS[kind], `${kind} has no seeded defaults`);
  }
});
