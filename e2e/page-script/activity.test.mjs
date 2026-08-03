/* Activity is two things, and a still-running job must never be filed as history.
 *
 * Runs under `npm run test:page` (node --test) against the REAL
 * `src/shell/activity.ts`, type-stripped in memory — the same trick the tabsync
 * and agentNodes tests use, because AiPane.tsx itself needs React and the whole
 * Tauri backend before it renders a row.
 *
 * The owner's decision #12: Activity is BOTH a live manager AND an audit log,
 * VISUALLY SEPARATED. Before this the panel was one undifferentiated list —
 * `[...running, ...parked]` under a single "Running now" heading — and finished
 * jobs were dropped by `refreshJobs` before they ever reached it, so there was
 * no log at all. The rule lives in its own module precisely so the counters, the
 * attention dot and the list can be pinned to ONE definition of which side a job
 * is on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "../../src/shell/activity.ts"), "utf8");
const JS = ts.transpileModule(SOURCE, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { groupActivity, HISTORY_LIMIT, runningJobCount } = await import(
  `data:text/javascript,${encodeURIComponent(JS)}`
);

const job = (id, status) => ({ id, status });

test("the live manager and the audit log are disjoint, and cover everything", () => {
  const jobs = [
    job("run", "running"),
    job("wait", "queued"),
    job("stop", "paused"),
    job("bad", "error"),
    job("old", "done"),
  ];
  const { active, parked, history } = groupActivity(jobs);
  assert.deepEqual(active.map((j) => j.id), ["run", "wait"]);
  assert.deepEqual(parked.map((j) => j.id), ["stop", "bad"]);
  assert.deepEqual(history.map((j) => j.id), ["old"]);
  // Nothing dropped, nothing counted twice.
  assert.equal(active.length + parked.length + history.length, jobs.length);
});

test("a still-running job never appears in history", () => {
  // The one invariant the split exists to protect: filing live work under
  // "already happened" would tell the user something finished that is still
  // going, and hand them a record where they needed a Stop button.
  for (const status of ["running", "queued"]) {
    const { active, history } = groupActivity([job("j", status)]);
    assert.equal(history.length, 0, `${status} must not be history`);
    assert.equal(active.length, 1);
  }
});

test("a status this build has never heard of stays actionable, not archived", () => {
  // history is an allow-list of the one status that means finished. An unknown
  // status (a newer room file, a job kind added later) lands in the LIVE side,
  // where the worst case is a card the user can dismiss — the other direction
  // would quietly declare unfinished work done.
  const { parked, history } = groupActivity([job("weird", "hibernating")]);
  assert.deepEqual(parked.map((j) => j.id), ["weird"]);
  assert.equal(history.length, 0);
});

test("a job parked by a lock is live work, not a log entry", () => {
  // A parked job is 'paused' plus a reason — the backend deliberately does not
  // mint a sixth status, so the grouping must keep treating it as resumable.
  const parkedByLock = {
    id: "p",
    status: "paused",
    parkedReason: "The room was locked while this was still running.",
  };
  const { active, parked, history } = groupActivity([parkedByLock]);
  assert.equal(active.length, 0);
  assert.deepEqual(parked.map((j) => j.id), ["p"]);
  assert.equal(history.length, 0);
});

test("an empty room groups to three empty lists, not to a claim", () => {
  const { active, parked, history } = groupActivity([]);
  assert.deepEqual([active, parked, history], [[], [], []]);
});

test("history is capped, and the cap is a real number the pane can name", () => {
  assert.ok(Number.isInteger(HISTORY_LIMIT) && HISTORY_LIMIT > 0);
  const many = Array.from({ length: HISTORY_LIMIT + 7 }, (_, i) =>
    job(`d${i}`, "done"),
  );
  const { history } = groupActivity(many);
  // The grouping itself hides nothing — the pane slices and says how many of
  // how many it is showing, so the count is always available to be told.
  assert.equal(history.length, many.length);
});

test("keeping finished jobs in the list does not inflate the running count", () => {
  // `refreshJobs` now keeps `done` rows so history can exist at all. Every
  // caller that means "is something in flight" has to keep saying so — the
  // status-bar badge and the attention dot both read this.
  const state = {
    jobs: [job("old", "done"), job("older", "done"), job("run", "running")],
    summaryStarting: false,
    recSave: null,
    recLive: null,
  };
  assert.equal(runningJobCount(state), 1);
  state.jobs = [job("old", "done")];
  assert.equal(runningJobCount(state), 0);
});
