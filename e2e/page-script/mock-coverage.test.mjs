/* Runs the frontend ↔ host ↔ qa-mock drift checker as a test.
 *
 * `qa/check-mock-coverage.mjs` exits 1 when the frontend invokes a Tauri
 * command the host does not register, or when qa-mock.js fakes one Rust no
 * longer has. That is exactly how `save_page` → `browse_save` slipped through:
 * the browser harness kept answering the old name and stayed green while the
 * shipped build broke. The checker was written to catch it but nothing ran it
 * — no npm script, no preflight step, no CI step — so a rename today would
 * still go green everywhere.
 *
 * Hanging it off `npm run test:page` covers all three at once: `npm test`
 * (preflight --suites), a full `scripts/preflight.sh`, and the frontend CI job.
 * The fixture gap it also reports is a number to watch, not a failure — the
 * checker's own exit code is the contract, so this asserts nothing more.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("no frontend/host/qa-mock command drift", () => {
  const run = spawnSync(
    process.execPath,
    [join(root, "qa/check-mock-coverage.mjs"), "--bridge=electron"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(
    run.status,
    0,
    `qa/check-mock-coverage.mjs failed — run it for the full list:\n${run.stdout}${run.stderr}`,
  );
});
