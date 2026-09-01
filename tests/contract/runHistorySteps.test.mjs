/* Run history shows what the RUN recorded, not what the editor holds now.
 *
 * The panel fetched a run's step artifacts by index 0…nodeCount-1, where
 * nodeCount is the workflow's node count in the editor RIGHT NOW — unsaved
 * edits included. Delete two steps from a 6-step workflow and every past run of
 * the 6-step version silently listed four, with nothing saying two more were
 * recorded; the history changed as the definition was edited.
 *
 * This drives the REAL fetch out of the real `RunHistory.tsx` (type-stripped in
 * memory, same trick as activityPane.test.mjs) against a recorded run of six
 * steps, with `api` replaced by a recorder — so the assertion is about which
 * indices the panel asks the host for and what it keeps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadTypescriptModule } from "../support/source-modules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../../apps/desktop/src/renderer");

/* ---------- loading real TSX under plain node (same trick as activityPane) ---------- */

const BARE = {
  react: import.meta.resolve("react"),
  "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
};

/** The recorded run: six steps, and nothing at index 6 or beyond. `__asked`
 *  keeps every index the panel requested, in order. */
const API_RECORDER = `{
  getJobStepArtifact: (jobId, i) => {
    globalThis.__asked.push(i);
    const store = globalThis.__artifacts;
    return Promise.resolve(Object.prototype.hasOwnProperty.call(store, i) ? store[i] : null);
  },
}`;

// The backend seam and the panel's neighbours: `api` is the recorder above,
// the icon set and the status-dot selector are not what this test is about.
const STUBS = new Map(
  ["api.ts", "icons.tsx", "workspace/workflows/selectors.ts"].map((p) => [join(SRC, p), {}]),
);
STUBS.set(join(SRC, "api.ts"), { api: API_RECORDER });
const PRIVATE_EXPORTS = new Map([
  [join(SRC, "workspace/workflows/RunHistory.tsx"), "\nexport { fetchRunSteps };\n"],
]);
const { fetchRunSteps } = await import(
  loadTypescriptModule(join(SRC, "workspace/workflows/RunHistory.tsx"), {
    bare: BARE,
    stubs: STUBS,
    append: PRIVATE_EXPORTS,
  }),
);

/** A run of `n` steps, each with a stored WfArtifact. */
function recorded(n) {
  globalThis.__asked = [];
  globalThis.__artifacts = Object.fromEntries(
    Array.from({ length: n }, (_, i) => [i, JSON.stringify({ result: `step ${i}`, skipped: false })]),
  );
}

test("a run longer than the editor's current node count keeps all its steps", async () => {
  recorded(6);
  // The editor is showing a trimmed 4-step version of the same workflow.
  const steps = await fetchRunSteps("job1", 4);
  assert.equal(steps.filter((a) => a != null).length, 6, "the run's last two steps were dropped");
  assert.match(String(steps[5]), /step 5/);
});

test("an unsaved edit cannot change a past run's steps", async () => {
  recorded(6);
  const trimmed = await fetchRunSteps("job1", 4);
  recorded(6);
  const grown = await fetchRunSteps("job1", 9);
  assert.deepEqual(
    trimmed.filter((a) => a != null),
    grown.filter((a) => a != null),
  );
});

test("nothing recorded reads as nothing, not as a step", async () => {
  recorded(0);
  const steps = await fetchRunSteps("job1", 4);
  assert.deepEqual(steps.filter((a) => a != null), []);
});

test("a run that stopped after one step stops the probe there", async () => {
  recorded(1);
  const steps = await fetchRunSteps("job1", 1);
  assert.equal(steps.filter((a) => a != null).length, 1);
  // Bounded: the panel must not walk the index space looking for a run's end.
  assert.ok(globalThis.__asked.length <= 24, `asked for ${globalThis.__asked.length} indices`);
});
