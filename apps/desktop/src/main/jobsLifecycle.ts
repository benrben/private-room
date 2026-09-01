/** Job progress, room pinning, and parked-job lifecycle handling. */

import type Database from "better-sqlite3-multiple-ciphers";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import {
  type Job,
  dedupeParkedJobs,
  getJob,
  markJobParking as dbMarkJobParking,
  parkJob as dbParkJob,
  pruneJobHistory,
  setJobStatus,
  unfinishedJobs,
} from "./db-host/jobs.js";
import { finishWorkflowRunByJob, setWorkflowRunStatusByJob } from "./db-host/workflows.js";

// ============================================================================
// progress events / the room pin
// ============================================================================

/** The `job-progress` event payload — the union of every field ANY runner in
 * `jobs.rs` sends through its `serde_json::json!({...})` literals; a given
 * event sets only the ones relevant to it, exactly as those macros do. */
export interface JobProgressPayload {
  jobId: string;
  label: string;
  done: number;
  total: number;
  finished?: boolean;
  paused?: boolean;
  failed?: boolean;
  fileId?: string | null;
}

/** Where `job-progress` events go — Rust's `window.emit("job-progress", …)`.
 * No Electron `BrowserWindow` wiring exists in this rewrite yet; a future
 * batch's implementation is a thin `webContents.send("job-progress", payload)`
 * adapter (or a one-line bridge to `turn.ts`'s existing `EventSender`), and
 * tests use a recording stub. */
export interface ProgressSink {
  emit(payload: JobProgressPayload): void;
}

/** Emit the job's live progress. `label` is human ("Reading part 4 of 17");
 * `done`/`total` drive the bar. */
export function emitProgress(
  sink: ProgressSink,
  jobId: string,
  label: string,
  done: number,
  total: number
): void {
  sink.emit({ jobId, label, done, total });
}

/** One open room, as much of it as this batch's runners need. */
export interface RoomHandle {
  db: Database.Database;
  path: string;
  /** Present for hybrid rooms whose current bytes are normal files. */
  workspace?: WorkspaceService;
}

/**
 * Minimal stand-in for `tauri::State<'_, AppState>`'s room access, scoped to
 * exactly what `jobs.rs`'s runners use it for: reading the CURRENTLY open room
 * so a write can be pinned to the room the job started in ("a room closed or
 * swapped mid-run can never receive this job's writes" — every runner in the
 * Rust source re-checks `room.path == room_path` before every read/write).
 */
export interface RoomSource {
  /** The open room, or `null` if none is open. */
  current(): RoomHandle | null;
}

/** `room.db` only if the room currently open is STILL the one this job started
 * in — the room-pin discipline every runner in `jobs.rs` applies by hand before
 * every read/write (`guard.as_ref().filter(|r| r.path == room_path)`). */
export function pinnedDb(rooms: RoomSource, roomPath: string): Database.Database | null {
  const room = rooms.current();
  return room !== null && room.path === roomPath ? room.db : null;
}

// ============================================================================
// Job-lifecycle housekeeping — DB-only, no AppState/Window needed
// ============================================================================

/** Why a job stopped when the room was LOCKED (or swapped) under it. The user
 * caused this, but not by pressing Stop, so the card must not read like a pause
 * they chose — "Resume" on a job they never paused is a small lie about who
 * stopped it and why the work is unfinished. */
export const PARKED_BY_LOCK = "The room was locked while this was still running.";

/** Why a job stopped when the APP went away — a quit, a crash, a forced
 * restart. Detected at the next unlock, because nothing ran at exit to say
 * it. */
export const PARKED_BY_EXIT = "The app closed while this was still running.";

/**
 * Stamp the parking reason on every live top-level job, WITHOUT stopping any of
 * them. Called from the lock/close drain while the room is still open and the
 * runners are still alive, so whichever way each runner lands a moment later
 * the row can already say what interrupted it. Returns how many rows were
 * stamped.
 *
 * 'running' ONLY. A queued row is never parked by the app —
 * {@link parkRunningJobs} and {@link quiesceStaleJobs} both skip it so the
 * queue pump can auto-start it — and if the pump promotes one to 'running'
 * during the drain, `parkJob` writes the reason itself. So stamping a queued
 * row can never come true, and it does come back to bite: the only way a queued
 * row reaches 'paused' is the user pressing Remove, and `setJobStatus(..,
 * "paused")` deliberately PRESERVES the reason (the running runner's epilogue
 * depends on that), so the card would blame the lock for a removal the user
 * chose, on work that never started.
 */
export function markJobsParking(db: Database.Database, reason: string): number {
  let jobs: Job[];
  try {
    jobs = unfinishedJobs(db);
  } catch {
    return 0;
  }
  let count = 0;
  for (const j of jobs) {
    if (j.status !== "running") {
      continue;
    }
    try {
      dbMarkJobParking(db, j.id, reason);
      count += 1;
    } catch {
      // A write that failed did not stamp a row, so it is not counted.
    }
  }
  return count;
}

/**
 * Park every job still reading as 'running' — the runner is gone, or is about
 * to lose the room it writes to. Returns how many were parked.
 *
 * 'queued' is deliberately left alone: a queued job never started, holds no
 * half-finished work, and the pump auto-resumes it at the next unlock.
 * Demoting it here is exactly the change that once made `pump_on_open` a dead
 * no-op.
 */
export function parkRunningJobs(db: Database.Database, reason: string): number {
  let jobs: Job[];
  try {
    jobs = unfinishedJobs(db);
  } catch {
    return 0;
  }
  let parked = 0;
  for (const j of jobs) {
    if (j.status !== "running") {
      continue;
    }
    try {
      dbParkJob(db, j.id, reason);
    } catch {
      continue;
    }
    // A workflow's run row must stop reading as 'running' too, or its history
    // line keeps a live green dot for a job that is parked. Harmless (a no-op
    // UPDATE) for the other job kinds — they have no run row.
    try {
      setWorkflowRunStatusByJob(db, j.id, "paused");
    } catch {
      // best-effort, mirrors the Rust `let _ = ...`
    }
    parked += 1;
  }
  return parked;
}

/**
 * On room open, any job left 'running' belongs to a process that's gone — park
 * those 'paused' so the UI offers Resume instead of a phantom active card. The
 * lock path parks its own jobs before the room handle drops, so what reaches
 * here still reading 'running' is work the app never got to say goodbye to: a
 * quit, a crash, a kill. Naming that is the whole point — "Paused" alone
 * described a deliberate Stop the user never made.
 */
export function quiesceStaleJobs(db: Database.Database): void {
  parkRunningJobs(db, PARKED_BY_EXIT);
  // Those rows became parked JUST NOW — after migrate()'s duplicate sweep had
  // already run (open_room migrates, then quiesces). A workflow still 'running'
  // when the app died is exactly the row that superseded the parked attempt
  // beside it, so without this the user opens the room and still sees two
  // indistinguishable cards for one workflow. Sweeping again here costs one
  // scan of a handful of rows and is a no-op on a room that is already clean.
  try {
    dedupeParkedJobs(db);
  } catch {
    // best-effort, mirrors the Rust `let _ = ...`
  }
  // And roll the finished history off the back. Nothing else ever removed a
  // 'done' job, its artifacts or a closed run row, so an interval-scheduled
  // workflow grew the encrypted room file without bound. Room open is the one
  // moment the connection is held with no runner attached to any row.
  try {
    pruneJobHistory(db);
  } catch {
    // best-effort, mirrors the Rust `let _ = ...`
  }
}

/**
 * Park a job whose runner died without reaching its own epilogue.
 *
 * Returns the row's `{cursor, total}` when it actually parked something, and
 * `null` when the row was already off the live statuses — a failure caught in
 * the epilogue AFTER the terminal write must not rewrite a real 'done' as a
 * failure, and a 'paused' row is already resumable and already honest. Only
 * 'running' and 'queued' still read as live work, so only those are parked.
 *
 * Throws (via `getJob`) if the row itself is unreadable, exactly where Rust's
 * `?` propagates: there is nothing to park, so nothing is reported parked.
 */
export function parkCrashedJob(
  db: Database.Database,
  jobId: string,
  reason: string
): { cursor: number; total: number } | null {
  const job = getJob(db, jobId);
  if (job.status !== "running" && job.status !== "queued") {
    return null;
  }
  setJobStatus(db, jobId, "error", reason);
  // A workflow job also owns a `workflow_runs` row; the other kinds have none
  // and this is a no-op for them (same reasoning as `quiesceStaleJobs`).
  try {
    finishWorkflowRunByJob(db, jobId, "error", reason);
  } catch {
    // best-effort, mirrors the Rust `let _ = ...`
  }
  return { cursor: job.cursor, total: job.total };
}

// ============================================================================
// crashReason / spawnJobRunner — panic_reason / spawn_job_runner
// ============================================================================

/**
 * A caught failure as a sentence fit for a job's `error` column. Ported from
 * `panic_reason`: `catch_unwind`'s payload is `Box<dyn Any>`, of which only the
 * `&str`/`String` cases carry a message; the JS equivalent is a caught value of
 * unknown shape, at least as likely to already BE an `Error`. Either way the
 * fallback must still say a CRASH happened rather than leaving the column blank
 * for the Sidebar to render as "Stopped — " explaining nothing.
 */
export function crashReason(err: unknown): string {
  const detail =
    err instanceof Error && err.message.trim() !== ""
      ? err.message
      : typeof err === "string" && err.trim() !== ""
        ? err
        : null;
  return detail !== null ? `the job runner crashed: ${detail}` : "the job runner crashed";
}
