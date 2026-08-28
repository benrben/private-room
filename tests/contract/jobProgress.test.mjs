/* What a background-job row may honestly say about its own progress.
 *
 * The rule is pure (src/workspace/jobProgress.ts) so it can be argued with here
 * rather than discovered by starting a job and watching. What is pinned is the
 * one thing this row is for: never showing a quantity the job has not reported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const SOURCE = readFileSync(join(root, "apps/desktop/src/renderer/workspace/jobProgress.ts"), "utf8");

const js = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { jobMeter } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

test("a job that has not reported a total states no fraction", () => {
  // The defect this exists to stop: a job that has only just started reports
  // no total, and a `Math.max(total, 1)` guard — there to keep the bar's width
  // arithmetic safe — turned that absence into the claim "0 of 1". The row said
  // "Starting…" and "0 / 1" in the same breath: one step, none of them done,
  // both invented.
  const m = jobMeter("running", 0, 0, { label: "Starting…", done: 0, total: 0 });
  assert.equal(m.indeterminate, true, "with no total known the bar cannot be positioned");
  assert.equal(m.figure, null, "and no fraction may be printed");
});

test("a job that has reported a total states it", () => {
  const m = jobMeter("running", 0, 0, { label: "Reading", done: 3, total: 12 });
  assert.equal(m.indeterminate, false);
  assert.deepEqual(m.figure, { done: 3, total: 12 });
});

test("a running job with no progress event at all is indeterminate", () => {
  const m = jobMeter("running", 0, 0, undefined);
  assert.equal(m.indeterminate, true);
  assert.equal(m.figure, null);
});

test("a queued job shows its real starting point, never an animation", () => {
  // A queued job has not begun. An indeterminate bar over it animates work
  // that nothing is doing, and under reduced motion degrades to a FULL bar.
  const m = jobMeter("queued", 0, 7, undefined);
  assert.equal(m.indeterminate, false, "a job that has not started must not animate");
  assert.deepEqual(m.figure, { done: 0, total: 7 });
});

test("a parked job resumes from where it stopped, not from zero", () => {
  const m = jobMeter("paused", 4, 10, undefined);
  assert.equal(m.indeterminate, false);
  assert.deepEqual(m.figure, { done: 4, total: 10 });
});

test("a fraction never reads past its own total", () => {
  // A backend that over-counts must not produce "13 of 12".
  const m = jobMeter("running", 0, 0, { label: "x", done: 13, total: 12 });
  assert.deepEqual(m.figure, { done: 12, total: 12 });
});

test("the bar's width is a real percentage and never divides by zero", () => {
  assert.equal(jobMeter("queued", 0, 0, undefined).percent, 0);
  assert.equal(jobMeter("running", 0, 0, { label: "x", done: 3, total: 12 }).percent, 25);
  assert.equal(jobMeter("running", 0, 0, { label: "x", done: 99, total: 12 }).percent, 100);
});
