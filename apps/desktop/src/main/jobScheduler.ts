/**
 * Wave 4a (M4): the workflow scheduler tick loop. Generation-pinned exactly
 * like `backfill.rs`: every room open bumps {@link SchedulerState.generation}
 * and spawns one loop carrying the new stamp; a loop whose stamp is stale
 * exits, so at most one scheduler is ever live.
 *
 * Ported from `src-tauri/src/commands/jobs/scheduler.rs` (334 lines, read in
 * full, including its `#[cfg(test)] mod tests`).
 *
 * Honest semantics, preserved: schedules fire ONLY while the app is open and
 * the room is unlocked. A run missed while the app was closed/locked performs
 * AT MOST ONE catch-up at unlock (never a backlog of N), and only if the
 * schedule opted in. Approval gates never apply — a scheduled workflow was
 * pre-consented when the user activated it, so a headless run never hangs on a
 * 180s prompt.
 *
 * WHAT IS INJECTED, and why: {@link StartWorkflowRun} stands in for Rust's
 * `start_workflow_run`, which lives entirely in `commands/jobs/workflow.rs` —
 * the workflow definition format, compiler and executor, a sub-module reserved
 * for a future batch (see `jobs.ts`'s module doc for the same exclusion applied
 * to `spawn_workflow_job`). Following "stub, don't fake" it defaults to
 * {@link startWorkflowRunNotImplemented}, which fails with a clearly-labeled
 * reason; a schedule that fires against it still advances its `next_run_at`
 * exactly like Rust's own `Err(_)` branch does, so an unbuilt workflow kind can
 * never hammer the tick loop every 30 seconds. Every OTHER piece
 * `tick`/`catchUpPass`/`fire` need — reading due schedules, advancing
 * `next_run_at`, recording a fired run — is real, against
 * `db-host/workflows.ts`.
 *
 * DEVIATION — `chrono::Local`/`DateTime<Local>` → native `Date`. No date/
 * timezone library is a dependency of this project, and none is needed: JS's
 * local-time `Date` constructor (`new Date(y, m, d, h, mi)`) already resolves
 * against the system timezone — the very notion `chrono::Local` names — so
 * every ordinary schedule (interval addition, daily/weekly "next occurrence")
 * resolves to an identical wall-clock instant. Two DST-boundary cases differ
 * and are documented rather than silently assumed:
 *
 *  - SPRING FORWARD (a nonexistent local time): chrono's
 *    `from_local_datetime(..).earliest()` returns `None` and the Rust resolver
 *    skips that day. V8 does not report a nonexistent wall-clock time at all —
 *    it normalizes forward across the gap. Both therefore return SOME valid
 *    future instant, which is exactly what the Rust test
 *    `dst_gap_day_still_resolves` asserts, so that test ports as-is; the two
 *    engines are simply not guaranteed to pick the same instant on that one
 *    day, and no test pins one.
 *  - FALL BACK (an ambiguous local time): chrono takes the EARLIEST of the two
 *    real instants; V8 resolves it however the host's ICU data does. No test in
 *    the Rust suite exercises this, so it is a documented gap rather than a
 *    diverging assertion.
 *
 * DEVIATION — no `main_window(app)`: Rust's `fire` bails when there is no live
 * window to fire into. That check folds into the same
 * `rooms.current() !== null` guard every write in this batch already uses.
 */

import {
  dueSchedules,
  markScheduleRun,
  type Schedule,
  setScheduleNextRun,
  type Workflow,
} from "./db-host/workflows.js";
import type { RoomSource } from "./jobs.js";

/** How often the loop looks, once its catch-up pass has settled. */
export const TICK_MS = 30_000;

// ============================================================================
// Pure date decisions — nextRunAfter / nextRunFromNow / isMissed
// ============================================================================

/** `Date` → the UTC ISO-8601 string the DB timestamps use
 * (`strftime('%Y-%m-%dT%H:%M:%SZ','now')`) — whole seconds, no milliseconds. */
function toUtcString(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Now, as that same UTC string. */
function utcNowString(): string {
  return toUtcString(new Date());
}

/**
 * A run of ASCII digits, as `str::parse::<u32>()` / `::<i64>()` accepts it.
 * Deliberately NOT `Number(s)`: that reads `""` as 0 (so `":30"` would parse as
 * midnight where Rust returns None), and accepts `"1e3"`, `"0x10"` and `"30.0"`
 * — none of which a Rust integer parse takes.
 */
function parseDigits(s: string, allowSign: boolean): number | null {
  const t = s.trim();
  if (!(allowSign ? /^-?\d+$/ : /^\d+$/).test(t)) {
    return null;
  }
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/** One parsed "HH:MM" clock time. */
interface ClockTime {
  readonly hour: number;
  readonly minute: number;
}

/** Rust's `parse_hhmm`: split at the FIRST colon, integer-parse both halves,
 * and reject anything `NaiveTime::from_hms_opt` would (hour > 23, minute > 59). */
function parseHhMm(s: string): ClockTime | null {
  const t = s.trim();
  const idx = t.indexOf(":");
  if (idx === -1) {
    return null;
  }
  const hour = parseDigits(t.slice(0, idx), false);
  const minute = parseDigits(t.slice(idx + 1), false);
  if (hour === null || minute === null || hour > 23 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

/** "D HH:MM" where D is 0=Sunday..6=Saturday — split at the FIRST whitespace
 * character, mirroring Rust's `split_once(char::is_whitespace)`. */
function parseDowHhMm(s: string): { readonly dow: number; readonly time: ClockTime } | null {
  const t = s.trim();
  const idx = t.search(/\s/);
  if (idx === -1) {
    return null;
  }
  const dow = parseDigits(t.slice(0, idx), false);
  if (dow === null || dow > 6) {
    return null;
  }
  const time = parseHhMm(t.slice(idx + 1));
  return time === null ? null : { dow, time };
}

/** Midnight local on the same calendar day — Rust's `after.date_naive()`. */
function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The next calendar day — Rust's `day.succ_opt()`. `setDate` normalizes month
 * and year rollover, and works in local calendar days rather than fixed 24h
 * offsets, so a DST day still advances by exactly one day. */
function addDays(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + days);
  return out;
}

/** The next LOCAL run time strictly after `after` matching `time` (and, if
 * given, `dow` — 0=Sunday..6=Saturday, which `Date#getDay()` already is). Two
 * weeks of candidate days, exactly as Rust's `0..14` loop. */
function nextAtTime(after: Date, time: ClockTime, dow: number | null): Date | null {
  let day = dateOnly(after);
  for (let i = 0; i < 14; i++) {
    if (dow === null || day.getDay() === dow) {
      const candidate = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        time.hour,
        time.minute,
        0,
        0
      );
      if (candidate.getTime() > after.getTime()) {
        return candidate;
      }
    }
    day = addDays(day, 1);
  }
  return null;
}

/**
 * The next local run time strictly after `after`. Pure — unit-tested,
 * including a DST-gap day (see the module doc). Returns `null` on a malformed
 * param or an unknown `kind`.
 *
 * DEVIATION — an unrepresentable instant is a MALFORMED param, not a crash.
 * `parseDigits` accepts any safe integer, so a big enough `interval` pushes the
 * sum past the ±8.64e15 ms a `Date` can hold. JS does not report that as an
 * error: it hands back an Invalid Date that only blows up later, at the
 * `toISOString()` inside {@link toUtcString} — which is called from `fire`
 * BEFORE its try block, so the throw escapes {@link tick} and rejects the
 * fire-and-forget loop, silently retiring the scheduler for the session and
 * dropping every later schedule in the batch. (Rust's `after + Duration` panics
 * on the same overflow, killing its spawned task just as quietly; nothing about
 * either is intended behaviour.) This function's stated contract is that a
 * malformed param answers None, and a number that cannot name an instant is
 * exactly that — so the single guard below makes the contract true for every
 * branch rather than only the ones that happen to parse.
 */
export function nextRunAfter(kind: string, param: string, after: Date): Date | null {
  const next = ((): Date | null => {
    switch (kind) {
      case "interval": {
        const mins = parseDigits(param, true);
        if (mins === null || mins <= 0) {
          return null;
        }
        return new Date(after.getTime() + mins * 60_000);
      }
      case "daily": {
        const t = parseHhMm(param);
        return t === null ? null : nextAtTime(after, t, null);
      }
      case "weekly": {
        const parsed = parseDowHhMm(param);
        return parsed === null ? null : nextAtTime(after, parsed.time, parsed.dow);
      }
      default:
        return null;
    }
  })();
  return next !== null && Number.isNaN(next.getTime()) ? null : next;
}

/** The next run time as a stored UTC string, computed from NOW. */
export function nextRunFromNow(kind: string, param: string): string | null {
  const next = nextRunAfter(kind, param, new Date());
  return next === null ? null : toUtcString(next);
}

/**
 * Parse one of the stored timestamps. Shape-checked before `Date.parse`,
 * because `Date.parse` is far more permissive than Rust's
 * `DateTime::parse_from_rfc3339` — it would read `"2026-08-18"` as a real
 * instant where Rust reports None, and "not a timestamp" must not become
 * evidence about when something was due.
 */
function parseStoredTimestamp(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    return null;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/**
 * Was this schedule's slot passed while the loop was already watching and did
 * NOT fire it? Then nothing was ever going to: at that moment the workflow was
 * a draft or the schedule was off, which is the same missed run "Catch up at
 * unlock" governs.
 *
 * `watchingSince` is the START of the PREVIOUS tick, deliberately — not a grace
 * period measured from now. A slot that fell after it (the machine was asleep,
 * the clock jumped, a tick was slow) was never looked at, so it is merely LATE,
 * and a late run still runs. A lateness threshold cannot tell those apart and
 * would silently drop a run the user was owed.
 *
 * Both timestamps are the stored UTC strings; an unreadable one is not evidence
 * of a miss.
 */
export function isMissed(nextRunAt: string | null, watchingSince: string): boolean {
  const due = nextRunAt === null ? null : parseStoredTimestamp(nextRunAt);
  if (due === null) {
    return false;
  }
  const since = parseStoredTimestamp(watchingSince);
  if (since === null) {
    return false;
  }
  return due < since;
}

// ============================================================================
// tick / catchUpPass / fire
// ============================================================================

/**
 * Start one scheduled workflow run — Rust's `start_workflow_run`, part of the
 * unported workflow engine. Resolves to the new job id, or `""` when the run
 * was SKIPPED (already in flight, or the queue is full) — the same sentinel
 * Rust's own `Ok(job_id) if job_id.is_empty()` branch reads. Rejects on a
 * genuine start failure (a broken definition), which {@link fire} treats
 * exactly like Rust's `Err(_)` arm.
 */
export type StartWorkflowRun = (
  workflowId: string,
  trigger: string,
  inputFileId: string | null
) => Promise<string>;

/** The stub {@link fire} falls back to when no real `startWorkflowRun` is
 * supplied — see this module's doc for why a failure here is still the honest
 * outcome. */
export const startWorkflowRunNotImplemented: StartWorkflowRun = () =>
  Promise.reject(
    new Error(
      "NOT_IMPLEMENTED: start_workflow_run (the workflow definition compiler " +
        "and executor) has no Electron port yet — this batch ports only the " +
        "tick loop and its due-schedule bookkeeping around it."
    )
  );

export interface SchedulerDeps {
  rooms: RoomSource;
  startWorkflowRun: StartWorkflowRun;
}

/** Generation stamp for the tick loop — the same pattern `backfill.rs`,
 * `embed_generation` and `auto_index_generation` all use. Every room open bumps
 * it and spawns one loop carrying the new stamp; a loop whose stamp has gone
 * stale exits, so at most one scheduler is ever live. */
export interface SchedulerState {
  generation: number;
}

export function createSchedulerState(): SchedulerState {
  return { generation: 0 };
}

/** Skip a missed run: advance `next_run_at` past now without firing, so the
 * schedule resumes at its next slot instead of running late. */
function skipMissedRun(deps: SchedulerDeps, sched: Schedule): void {
  const next = nextRunFromNow(sched.kind, sched.param);
  const room = deps.rooms.current();
  if (room === null) {
    return;
  }
  try {
    setScheduleNextRun(room.db, sched.id, next);
  } catch {
    // best-effort, mirrors the Rust `let _ = ...` — a write that fails must not
    // take the whole tick loop down with it.
  }
}

/** Start one scheduled run and advance the schedule's next run. */
async function fire(
  deps: SchedulerDeps,
  sched: Schedule,
  wf: Workflow,
  trigger: string
): Promise<void> {
  if (deps.rooms.current() === null) {
    return; // Rust's `let Some(window) = main_window(app) else { return }`.
  }
  const next = nextRunFromNow(sched.kind, sched.param);
  let jobId: string | null;
  try {
    jobId = await deps.startWorkflowRun(wf.id, trigger, null);
  } catch {
    // A failed start (a broken def, or the unbuilt-engine stub) still advances
    // the schedule so the loop doesn't hammer it every tick.
    jobId = null;
  }
  const room = deps.rooms.current();
  if (room === null) {
    return; // the room closed while starting the run; nothing left to write.
  }
  try {
    if (jobId !== null && jobId !== "") {
      markScheduleRun(room.db, sched.id, jobId, next);
    } else {
      // An empty id means the run was skipped (already in flight, or the queue
      // is full) — advance the schedule without recording a phantom run.
      setScheduleNextRun(room.db, sched.id, next);
    }
  } catch {
    // best-effort, as above.
  }
}

/** Read the currently-due schedules (a fresh read, no held lock) and fire each.
 * `watchingSince` is the previous tick's own start time — see {@link isMissed}. */
export async function tick(
  deps: SchedulerDeps,
  state: SchedulerState,
  generation: number,
  watchingSince: string
): Promise<void> {
  const room = deps.rooms.current();
  if (room === null) {
    return;
  }
  let due: Array<[Schedule, Workflow]>;
  try {
    due = dueSchedules(room.db, utcNowString());
  } catch {
    due = [];
  }
  for (const [sched, wf] of due) {
    if (state.generation !== generation) {
      return;
    }
    // A slot missed while the workflow was a draft is governed by "Catch up at
    // unlock" exactly as one missed while the app was closed is — otherwise
    // activating a workflow starts a full pass within 30 s.
    if (!sched.catchUp && isMissed(sched.nextRunAt, watchingSince)) {
      skipMissedRun(deps, sched);
      continue;
    }
    await fire(deps, sched, wf, "schedule");
  }
}

/** The one-shot catch-up at unlock: for every enabled schedule of an active
 * workflow whose next run is already past, fire AT MOST ONE catch-up (if the
 * schedule opted in), then advance `next_run_at` past now — never a backlog. */
export async function catchUpPass(
  deps: SchedulerDeps,
  state: SchedulerState,
  generation: number
): Promise<void> {
  const room = deps.rooms.current();
  if (room === null) {
    return;
  }
  let overdue: Array<[Schedule, Workflow]>;
  try {
    overdue = dueSchedules(room.db, utcNowString());
  } catch {
    overdue = [];
  }
  for (const [sched, wf] of overdue) {
    if (state.generation !== generation) {
      return;
    }
    if (sched.catchUp) {
      await fire(deps, sched, wf, "catchup");
    } else {
      skipMissedRun(deps, sched);
    }
  }
}

/** Sleep, without holding the process open on the timer alone: the scheduler is
 * a background loop, and nothing about the app's lifetime should depend on it
 * being between ticks. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer: unknown = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  });
}

/**
 * Spawn the generation-pinned scheduler for the open room: a one-shot catch-up
 * pass at unlock, then a tick every `tickMs` until the generation moves or the
 * room closes. Returns the generation it is running under — pass it (or just
 * call {@link stopWorkflowScheduler}) to retire this loop.
 *
 * Deliberately thin and not unit-tested beyond the generation pin: like
 * `obs.ts`'s `init()`, the decision logic it wires together
 * ({@link tick}/{@link catchUpPass}/{@link isMissed}/{@link nextRunAfter}) is
 * what carries the real coverage; this is the un-mocked seam to a real timer.
 */
export function spawnWorkflowScheduler(
  deps: SchedulerDeps,
  state: SchedulerState,
  tickMs: number = TICK_MS
): number {
  const generation = state.generation + 1;
  state.generation = generation;
  void (async () => {
    await catchUpPass(deps, state, generation);
    // Everything already overdue has just been settled, so the loop's watch
    // starts here: a slot older than this one was not skipped by us.
    let watchingSince = utcNowString();
    for (;;) {
      if (state.generation !== generation || deps.rooms.current() === null) {
        return;
      }
      const lookedAt = utcNowString();
      await tick(deps, state, generation, watchingSince);
      watchingSince = lookedAt;
      // Re-check BEFORE arming the timer, so a retired loop stops now rather
      // than after one more full tick interval.
      if (state.generation !== generation) {
        return;
      }
      await sleep(tickMs);
    }
  })();
  return generation;
}

/** Retire whatever loop is currently live: bump the generation, which every
 * loop checks between fires and between ticks. Idempotent, and the same
 * mechanism a room open uses. */
export function stopWorkflowScheduler(state: SchedulerState): void {
  state.generation += 1;
}
