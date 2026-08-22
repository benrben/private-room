/**
 * Vitest port of the `commands/jobs/scheduler.rs` tests
 * (`src-tauri/src/commands/jobs/scheduler.rs`, `mod tests`):
 *
 *   - interval_adds_minutes
 *   - daily_picks_today_then_tomorrow
 *   - weekly_finds_the_next_matching_weekday
 *   - same_weekday_later_time_is_today_earlier_is_next_week
 *   - dst_gap_day_still_resolves
 *   - a_slot_missed_while_the_workflow_was_a_draft_counts_as_missed
 *   - a_slot_the_loop_never_looked_at_is_late_not_missed
 *   - unknown_kind_is_none
 *
 * PLUS coverage this port adds for `tick`/`catchUpPass`/`fire`/`skipMissedRun`
 * against a real fixture room and an injected `startWorkflowRun` (the seam
 * standing in for the wholly unported `workflow.rs::start_workflow_run`), and
 * for the generation pin — none of which the Rust suite can reach without the
 * full Tauri `AppState`.
 *
 * Dates are built with `new Date(year, monthIndex, day, hour, minute)` — LOCAL
 * components, exactly mirroring the Rust tests' `Local.with_ymd_and_hms(...)`
 * (both resolve against the same system timezone), so the calendar arithmetic
 * (which weekday 2026-07-18 falls on, etc.) carries over unchanged.
 * `monthIndex` is 0-based, unlike the Rust tests' 1-based month, so `local()`
 * below takes the Rust spelling and converts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import {
  createWorkflow,
  getSchedule,
  setWorkflowStatus,
  upsertSchedule,
} from "./db-host/workflows.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import {
  catchUpPass,
  createSchedulerState,
  isMissed,
  nextRunAfter,
  nextRunFromNow,
  type SchedulerDeps,
  spawnWorkflowScheduler,
  startWorkflowRunNotImplemented,
  stopWorkflowScheduler,
  tick,
} from "./jobScheduler.js";

// `fire`/`skipMissedRun` are module-private (matching Rust's own `fn`
// visibility — neither is `pub` there either) and are exercised only THROUGH
// `tick`/`catchUpPass`, exactly like the Rust suite's own `mod tests`.

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "job-scheduler-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** Local time from 1-based calendar components — the Rust tests' spelling. */
function local(y: number, m: number, d: number, h: number, mi: number, s = 0): Date {
  return new Date(y, m - 1, d, h, mi, s);
}

function fakeRooms(handle: RoomHandle | null): RoomSource {
  return { current: () => handle };
}

function def(): unknown {
  return { version: 1, nodes: [], edges: [] };
}

/** An ACTIVE workflow with an enabled, already-overdue schedule. */
function overdueWorkflow(
  db: Database.Database,
  name: string,
  opts: { kind?: string; param?: string; catchUp?: boolean; nextRunAt?: string } = {}
): string {
  const id = createWorkflow(db, name, "", "", def(), "user", { scope: "general" });
  setWorkflowStatus(db, id, "active");
  upsertSchedule(
    db,
    id,
    opts.kind ?? "interval",
    opts.param ?? "30",
    true,
    opts.catchUp ?? true,
    opts.nextRunAt ?? "2000-01-01T00:00:00Z"
  );
  return id;
}

// ============================================================================
// nextRunAfter
// ============================================================================

describe("nextRunAfter", () => {
  it("interval_adds_minutes", () => {
    const after = local(2026, 7, 18, 10, 0);
    expect(nextRunAfter("interval", "30", after)).toEqual(local(2026, 7, 18, 10, 30));
    // A bad/zero interval is rejected.
    expect(nextRunAfter("interval", "0", after)).toBeNull();
    expect(nextRunAfter("interval", "abc", after)).toBeNull();
  });

  it("daily_picks_today_then_tomorrow", () => {
    // Before 08:00 today → today 08:00.
    expect(nextRunAfter("daily", "08:00", local(2026, 7, 18, 6, 0))).toEqual(
      local(2026, 7, 18, 8, 0)
    );
    // After 08:00 today → tomorrow 08:00.
    expect(nextRunAfter("daily", "08:00", local(2026, 7, 18, 9, 0))).toEqual(
      local(2026, 7, 19, 8, 0)
    );
  });

  it("weekly_finds_the_next_matching_weekday", () => {
    // 2026-07-18 is a Saturday (getDay() === 6). Ask for Friday (5).
    const after = local(2026, 7, 18, 12, 0);
    const next = nextRunAfter("weekly", "5 16:00", after);
    // Next Friday is 2026-07-24.
    expect(next).toEqual(local(2026, 7, 24, 16, 0));
    expect(next?.getDay()).toBe(5);
  });

  it("same_weekday_later_time_is_today_earlier_is_next_week", () => {
    // Saturday 12:00, ask Saturday (6) 16:00 → today.
    expect(nextRunAfter("weekly", "6 16:00", local(2026, 7, 18, 12, 0))).toEqual(
      local(2026, 7, 18, 16, 0)
    );
    // Saturday 18:00, ask Saturday 16:00 → next Saturday.
    expect(nextRunAfter("weekly", "6 16:00", local(2026, 7, 18, 18, 0))).toEqual(
      local(2026, 7, 25, 16, 0)
    );
  });

  it("dst_gap_day_still_resolves", () => {
    // On a US spring-forward day (2026-03-08, clocks jump 02:00→03:00), a 02:30
    // daily target doesn't exist locally. The resolver must still return SOME
    // future run — never null, never a crash, never a stuck schedule. (Which
    // valid instant it picks is deliberately not pinned; see the module doc.)
    const after = local(2026, 3, 7, 12, 0);
    const next = nextRunAfter("daily", "02:30", after);
    expect(next, "a valid daily schedule must always resolve").not.toBeNull();
    expect((next as Date).getTime()).toBeGreaterThan(after.getTime());
  });

  it("unknown_kind_is_none", () => {
    expect(nextRunAfter("monthly", "1", local(2026, 7, 18, 10, 0))).toBeNull();
  });

  it("rejects a malformed param the way an integer parse does, not the way Number() does", () => {
    // `Number("")` is 0 and `Number("1e3")` is 1000 — neither is something
    // Rust's `str::parse::<u32>()` accepts, and reading `":30"` as midnight
    // would silently schedule a run the user never asked for.
    const after = local(2026, 7, 18, 10, 0);
    for (const bad of [":30", "08:", "", "  ", "8", "1e1:00", "0x8:00", "-1:00", "08:0x0"]) {
      expect(nextRunAfter("daily", bad, after), `daily "${bad}"`).toBeNull();
    }
    // Out-of-range clock components are refused (NaiveTime::from_hms_opt).
    expect(nextRunAfter("daily", "24:00", after)).toBeNull();
    expect(nextRunAfter("daily", "08:60", after)).toBeNull();
    // …and the well-formed spellings Rust's `.trim()` calls do accept.
    expect(nextRunAfter("daily", " 08 : 00 ", after)).toEqual(local(2026, 7, 19, 8, 0));

    for (const bad of ["1e3", "0x10", "30.0", "", "  "]) {
      expect(nextRunAfter("interval", bad, after), `interval "${bad}"`).toBeNull();
    }
    for (const bad of ["7 16:00", "-1 16:00", "5", "5 25:00", "x 16:00"]) {
      expect(nextRunAfter("weekly", bad, after), `weekly "${bad}"`).toBeNull();
    }
  });

  it("an interval too large to be a real instant is refused, not returned as an Invalid Date", () => {
    // `parseDigits` accepts any safe integer, and a big enough one pushes the
    // sum past the ±8.64e15 ms a `Date` can hold — which JS reports NOT as an
    // error but as an Invalid Date that only blows up later, inside
    // `toUtcString`'s `toISOString()`. A param that cannot name an instant is
    // malformed, and this function's whole contract is that a malformed param
    // answers null.
    const after = local(2026, 7, 18, 10, 0);
    for (const huge of ["999999999999", "9007199254740991"]) {
      expect(nextRunAfter("interval", huge, after), `interval "${huge}"`).toBeNull();
    }
    // The largest interval that IS representable still resolves.
    expect(nextRunAfter("interval", "525600", after), "one year of minutes").not.toBeNull();
  });
});

describe("nextRunFromNow", () => {
  it("returns a stored-format UTC string, or null for a schedule that can't resolve", () => {
    const s = nextRunFromNow("interval", "5");
    expect(s).not.toBeNull();
    expect(s, "second precision, no milliseconds, Z suffix").toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
    );
    expect(nextRunFromNow("monthly", "1")).toBeNull();
    expect(nextRunFromNow("interval", "not a number")).toBeNull();
  });
});

// ============================================================================
// isMissed
// ============================================================================

describe("isMissed", () => {
  it("a_slot_missed_while_the_workflow_was_a_draft_counts_as_missed", () => {
    // The repro: daily 08:00, left in draft across it, activated at 10:00. The
    // loop was watching at 09:59:30 and did not fire it, so nothing was ever
    // going to.
    expect(isMissed("2026-08-18T08:00:00Z", "2026-08-18T09:59:30Z")).toBe(true);
    // One second before the previous look is still on the missed side.
    expect(isMissed("2026-08-18T09:59:29Z", "2026-08-18T09:59:30Z")).toBe(true);
  });

  it("a_slot_the_loop_never_looked_at_is_late_not_missed", () => {
    // The machine slept from 07:30 to 11:00 with the room unlocked: the 08:00
    // slot fell while nothing was watching, so it is owed a late run. A
    // lateness threshold would have called it missed and dropped it.
    expect(isMissed("2026-08-18T08:00:00Z", "2026-08-18T07:30:00Z")).toBe(false);
    // The boundary: due exactly at the previous look — that tick would have
    // fired it, so err towards running.
    expect(isMissed("2026-08-18T09:59:30Z", "2026-08-18T09:59:30Z")).toBe(false);
    // An ordinary live schedule, half a tick behind.
    expect(isMissed("2026-08-18T09:59:45Z", "2026-08-18T09:59:30Z")).toBe(false);
    // A future slot is never a miss (dueSchedules wouldn't return it).
    expect(isMissed("2026-08-18T11:00:00Z", "2026-08-18T09:59:30Z")).toBe(false);
    // Nothing to judge, or an unreadable stamp: not evidence of a miss.
    expect(isMissed(null, "2026-08-18T09:59:30Z")).toBe(false);
    expect(isMissed("whenever", "2026-08-18T09:59:30Z")).toBe(false);
    expect(isMissed("2026-08-18T08:00:00Z", "whenever")).toBe(false);
  });

  it("a value that is not a timestamp is never read as one", () => {
    // `Date.parse` is far more permissive than `DateTime::parse_from_rfc3339`:
    // it would read a bare date as a real instant. "Not a timestamp" must not
    // become evidence about when something was due.
    expect(isMissed("2026-08-18", "2026-08-18T09:59:30Z")).toBe(false);
    expect(isMissed("2026-08-18T08:00:00Z", "2026-08-18")).toBe(false);
    // A real RFC3339 offset form still parses, and compares as an instant.
    expect(isMissed("2026-08-18T10:00:00+03:00", "2026-08-18T09:59:30Z")).toBe(true);
  });
});

// ============================================================================
// tick / catchUpPass / fire / skipMissedRun
// ============================================================================

describe("tick", () => {
  it("fires a due, enabled schedule of an ACTIVE workflow and records the run", async () => {
    const db = freshRoom();
    const id = overdueWorkflow(db, "Morning digest");
    const fired: Array<[string, string, string | null]> = [];
    const deps: SchedulerDeps = {
      rooms: fakeRooms({ db, path: "room-a" }),
      startWorkflowRun: async (workflowId, trigger, inputFileId) => {
        fired.push([workflowId, trigger, inputFileId]);
        return "job-1";
      },
    };
    const state = createSchedulerState();

    await tick(deps, state, state.generation, "1999-01-01T00:00:00Z");

    expect(fired).toEqual([[id, "schedule", null]]);
    const sched = getSchedule(db, id);
    expect(sched?.lastJobId).toBe("job-1");
    expect(sched?.nextRunAt, "the schedule advanced past now").not.toBe("2000-01-01T00:00:00Z");
    db.close();
  });

  it("a draft workflow's due schedule never fires", async () => {
    const db = freshRoom();
    const id = createWorkflow(db, "wf", "", "", def(), "user", { scope: "general" });
    upsertSchedule(db, id, "interval", "30", true, true, "2000-01-01T00:00:00Z");
    const fired: string[] = [];
    const deps: SchedulerDeps = {
      rooms: fakeRooms({ db, path: "room-a" }),
      startWorkflowRun: async (workflowId) => {
        fired.push(workflowId);
        return "job-1";
      },
    };
    const state = createSchedulerState();

    await tick(deps, state, state.generation, "1999-01-01T00:00:00Z");

    expect(fired).toEqual([]);
    db.close();
  });

  it("a missed slot with catch_up off is skipped, and its next_run_at advances", async () => {
    // A slot missed while the workflow was a draft is governed by "Catch up at
    // unlock" exactly as one missed while the app was closed is — otherwise
    // activating a workflow starts a full pass within 30 s.
    const db = freshRoom();
    const id = overdueWorkflow(db, "wf", {
      kind: "daily",
      param: "08:00",
      catchUp: false,
      nextRunAt: "2026-08-18T08:00:00Z",
    });
    const fired: string[] = [];
    const deps: SchedulerDeps = {
      rooms: fakeRooms({ db, path: "room-a" }),
      startWorkflowRun: async (workflowId) => {
        fired.push(workflowId);
        return "job-1";
      },
    };
    const state = createSchedulerState();

    await tick(deps, state, state.generation, "2026-08-18T09:59:30Z");

    expect(fired, "a missed, non-catch-up slot must not fire").toEqual([]);
    const sched = getSchedule(db, id);
    expect(sched?.nextRunAt).not.toBe("2026-08-18T08:00:00Z");
    expect(sched?.lastJobId, "a skip records no run").toBeNull();
    db.close();
  });

  it("a merely LATE slot still runs, even with catch_up off", async () => {
    // The other half of the same decision: a slot that fell after the previous
    // look was never looked at, so it is owed its run.
    const db = freshRoom();
    overdueWorkflow(db, "wf", {
      kind: "daily",
      param: "08:00",
      catchUp: false,
      nextRunAt: "2026-08-18T08:00:00Z",
    });
    const fired: string[] = [];
    const deps: SchedulerDeps = {
      rooms: fakeRooms({ db, path: "room-a" }),
      startWorkflowRun: async (workflowId) => {
        fired.push(workflowId);
        return "job-1";
      },
    };
    const state = createSchedulerState();

    await tick(deps, state, state.generation, "2026-08-18T07:30:00Z");

    expect(fired.length, "the loop was not watching when this fell due").toBe(1);
    db.close();
  });

  it("a SKIPPED start (empty job id) advances the schedule without a phantom run", async () => {
    const db = freshRoom();
    const id = overdueWorkflow(db, "wf");
    const deps: SchedulerDeps = {
      rooms: fakeRooms({ db, path: "room-a" }),
      startWorkflowRun: async () => "",
    };
    const state = createSchedulerState();

    await tick(deps, state, state.generation, "1999-01-01T00:00:00Z");

    const sched = getSchedule(db, id);
    expect(sched?.lastJobId, "no phantom run recorded").toBeNull();
    expect(sched?.nextRunAt).not.toBe("2000-01-01T00:00:00Z");
    db.close();
  });

  it("a failed start still advances the schedule, so a broken workflow can't hammer every tick", async () => {
    const db = freshRoom();
    const id = overdueWorkflow(db, "wf");
    const deps: SchedulerDeps = {
      rooms: fakeRooms({ db, path: "room-a" }),
      startWorkflowRun: startWorkflowRunNotImplemented,
    };
    const state = createSchedulerState();

    await tick(deps, state, state.generation, "1999-01-01T00:00:00Z");

    const sched = getSchedule(db, id);
    expect(sched?.lastJobId).toBeNull();
    expect(sched?.nextRunAt).not.toBe("2000-01-01T00:00:00Z");
    db.close();
  });

  it("the stub itself fails with a labeled reason rather than hanging or succeeding", async () => {
    await expect(startWorkflowRunNotImplemented("wf-1", "schedule", null)).rejects.toThrow(
      "NOT_IMPLEMENTED"
    );
  });

  it("a stale generation stops the tick before firing anything further", async () => {
    // The generation pin: a second room open supersedes this loop mid-batch,
    // and the older one must stop rather than keep starting that room's work.
    const db = freshRoom();
    overdueWorkflow(db, "a");
    overdueWorkflow(db, "b", { nextRunAt: "2000-01-01T00:00:01Z" });
    const started: string[] = [];
    const state = createSchedulerState();
    state.generation = 1;
    const deps: SchedulerDeps = {
      rooms: fakeRooms({ db, path: "room-a" }),
      startWorkflowRun: async (workflowId) => {
        started.push(workflowId);
        state.generation += 1; // simulate a new room open mid-tick
        return "job-1";
      },
    };

    await tick(deps, state, 1, "1999-01-01T00:00:00Z");

    expect(started.length, "only the first due schedule fired").toBe(1);
    db.close();
  });

  it("a schedule whose param cannot name an instant does not kill the tick loop", async () => {
    // The consequence of the Invalid Date above, at the level that matters:
    // `nextRunFromNow` is called OUTSIDE `fire`'s try (it is computed before
    // the start attempt, exactly as Rust does), so a throw there rejects
    // `tick`, and `tick` is driven by a fire-and-forget loop with nothing to
    // catch it — an unhandled rejection, and a scheduler that stops for the
    // rest of the session with no record of why. Every LATER schedule in the
    // same batch is dropped too, which is the part a user would see.
    const db = freshRoom();
    overdueWorkflow(db, "broken", { kind: "interval", param: "999999999999" });
    const later = overdueWorkflow(db, "fine", {
      kind: "interval",
      param: "30",
      nextRunAt: "2000-01-01T00:00:01Z",
    });
    const fired: string[] = [];
    const deps: SchedulerDeps = {
      rooms: fakeRooms({ db, path: "room-a" }),
      startWorkflowRun: async (workflowId) => {
        fired.push(workflowId);
        return "job-1";
      },
    };
    const state = createSchedulerState();

    await expect(tick(deps, state, state.generation, "1999-01-01T00:00:00Z")).resolves.toBeUndefined();

    // The healthy schedule behind it still ran, and still advanced.
    expect(fired).toContain(later);
    expect(getSchedule(db, later)?.nextRunAt).not.toBe("2000-01-01T00:00:01Z");
    db.close();
  });

  it("is a no-op with no room open", async () => {
    const deps: SchedulerDeps = {
      rooms: fakeRooms(null),
      startWorkflowRun: async () => "job-1",
    };
    const state = createSchedulerState();
    await expect(tick(deps, state, state.generation, "2026-01-01T00:00:00Z")).resolves.toBeUndefined();
    await expect(catchUpPass(deps, state, state.generation)).resolves.toBeUndefined();
  });
});

describe("catchUpPass", () => {
  it("fires an opted-in overdue schedule as a catchup, and skips one that opted out", async () => {
    const db = freshRoom();
    const optedIn = overdueWorkflow(db, "a", { catchUp: true });
    const optedOut = overdueWorkflow(db, "b", { catchUp: false });
    const fired: Array<[string, string]> = [];
    const deps: SchedulerDeps = {
      rooms: fakeRooms({ db, path: "room-a" }),
      startWorkflowRun: async (workflowId, trigger) => {
        fired.push([workflowId, trigger]);
        return "job-1";
      },
    };
    const state = createSchedulerState();

    await catchUpPass(deps, state, state.generation);

    expect(fired, "AT MOST ONE catch-up, and only for the opt-in").toEqual([[optedIn, "catchup"]]);
    // The opted-out schedule advanced past now, never fired.
    const skipped = getSchedule(db, optedOut);
    expect(skipped?.nextRunAt).not.toBe("2000-01-01T00:00:00Z");
    expect(skipped?.lastJobId).toBeNull();
    db.close();
  });
});

// ============================================================================
// spawnWorkflowScheduler — the generation-pinned loop
// ============================================================================

describe("spawnWorkflowScheduler", () => {
  it("runs a catch-up pass, then keeps ticking until the generation moves", async () => {
    const db = freshRoom();
    overdueWorkflow(db, "wf", { param: "1" });
    let fires = 0;
    const deps: SchedulerDeps = {
      rooms: fakeRooms({ db, path: "room-a" }),
      startWorkflowRun: async () => {
        fires += 1;
        return `job-${fires}`;
      },
    };
    const state = createSchedulerState();

    const generation = spawnWorkflowScheduler(deps, state, 1);
    expect(generation).toBe(1);
    expect(state.generation).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(fires, "the catch-up pass fired the one overdue schedule").toBeGreaterThanOrEqual(1);

    // Nothing else is due (the schedule advanced an hour out), so later ticks
    // fire nothing more.
    const afterCatchUp = fires;
    await new Promise((r) => setTimeout(r, 20));
    expect(fires).toBe(afterCatchUp);

    stopWorkflowScheduler(state);
    expect(state.generation, "a bump retires the live loop").toBe(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(fires, "a retired loop fires nothing further").toBe(afterCatchUp);
    db.close();
  });

  it("a second spawn supersedes the first, so at most one scheduler is live", async () => {
    const db = freshRoom();
    const deps: SchedulerDeps = {
      rooms: fakeRooms({ db, path: "room-a" }),
      startWorkflowRun: async () => "job-1",
    };
    const state = createSchedulerState();

    expect(spawnWorkflowScheduler(deps, state, 1)).toBe(1);
    expect(spawnWorkflowScheduler(deps, state, 1)).toBe(2);
    expect(state.generation).toBe(2);
    stopWorkflowScheduler(state);
    await new Promise((r) => setTimeout(r, 10));
    db.close();
  });

  it("stops on its own once the room closes", async () => {
    const db = freshRoom();
    overdueWorkflow(db, "wf");
    let open = true;
    let fires = 0;
    const deps: SchedulerDeps = {
      rooms: { current: () => (open ? { db, path: "room-a" } : null) },
      startWorkflowRun: async () => {
        fires += 1;
        return "job-1";
      },
    };
    const state = createSchedulerState();
    spawnWorkflowScheduler(deps, state, 1);
    await new Promise((r) => setTimeout(r, 10));
    open = false;
    // Must not throw or hang once `current()` starts returning null mid-loop.
    const afterClose = fires;
    await new Promise((r) => setTimeout(r, 20));
    expect(fires).toBe(afterClose);
    stopWorkflowScheduler(state);
    db.close();
  });
});
