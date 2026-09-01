/* The schedule popover's own validation (audit 403).
 *
 * It used to check nothing: Save closed the popover, threw away what had been
 * typed, and only then did a red "That schedule is invalid — check the time or
 * interval" arrive from the backend — by which point the value needing the fix
 * was gone. `scheduleProblem` is the same rule `jobs/scheduler.rs` enforces
 * (`next_run_after`), so a schedule the popover accepts is one the backend
 * accepts.
 *
 * Exercises the REAL module: the source is type-stripped and imported, so the
 * popover cannot drift away from this test (same trick as address.test.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTypescriptModule } from "../support/source-modules.mjs";

const { scheduleProblem } = await import(
  loadTypescriptModule(
    "apps/desktop/src/renderer/workspace/workflows/SchedulePopover.tsx",
    {
      bare: {
        react: import.meta.resolve("react"),
        "react/jsx-runtime": import.meta.resolve("react/jsx-runtime"),
      },
    },
  ),
);

test("Off needs nothing", () => {
  assert.equal(scheduleProblem("", "", "", ""), null);
});

test("interval must be a whole number above zero", () => {
  assert.equal(scheduleProblem("interval", "30", "08:00", "16:00"), null);
  for (const bad of ["", "0", "-5", "abc", "1.5", "  "]) {
    assert.notEqual(
      scheduleProblem("interval", bad, "08:00", "16:00"),
      null,
      `"${bad}" should be refused`,
    );
  }
});

test("daily and weekly times must be a real 24-hour HH:MM", () => {
  assert.equal(scheduleProblem("daily", "30", "08:00", "16:00"), null);
  assert.equal(scheduleProblem("daily", "30", "23:59", "16:00"), null);
  for (const bad of ["25:00", "08:60", "8", "8:0", "noon", ""]) {
    assert.notEqual(
      scheduleProblem("daily", "30", bad, "16:00"),
      null,
      `daily "${bad}" should be refused`,
    );
    assert.notEqual(
      scheduleProblem("weekly", "30", "08:00", bad),
      null,
      `weekly "${bad}" should be refused`,
    );
  }
});

test("the message says what to type, not just that it is wrong", () => {
  assert.match(scheduleProblem("interval", "0", "08:00", "16:00"), /whole number/i);
  assert.match(scheduleProblem("daily", "30", "25:00", "16:00"), /HH:MM/);
});
