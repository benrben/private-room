/**
 * ADD-30: persistence for durable background jobs. A job is a step DAG (`plan`)
 * plus accumulating `state`; the runner checkpoints after every step so a job
 * resumes from `cursor` across app restarts. Pure DB plumbing — the scheduler
 * and step semantics live in `../jobs.ts` (this batch's port of
 * `commands::jobs`) and its siblings `../jobQueue.ts` / `../jobScheduler.ts`.
 *
 * Ported from `src-tauri/src/db/jobs.rs` (1175 lines, including its
 * `#[cfg(test)] mod tests`).
 *
 * ESTABLISHED CONVENTIONS reused from `util.ts`'s module comment: every
 * read/write goes through `queryOne`/`queryOpt`/`queryRows`/`executeOne` rather
 * than a bare `db.prepare` call site — EXCEPT {@link setJobStatus} and
 * {@link parkJob}, which need the raw affected-row count to decide whether to
 * log a transition (see below), so they call `db.prepare(...).run(...)`
 * directly, the same escape hatch `files.ts`'s `emptyTrash` uses for the same
 * reason. Rows are read positionally via `.raw()` (`Row`), matching the Rust
 * mappers' `r.get(i)` order column-for-column; a reused Rust `?1` becomes a `?`
 * repeated in the params array; a `Result<T, String>` becomes a thrown `Error`.
 *
 * CROSS-MODULE CALL: {@link deleteJob} closes a workflow's open run row via
 * `finishWorkflowRunByJob` from `./workflows.js` — exactly as `db/jobs.rs`
 * calls `crate::db::finish_workflow_run_by_job`, which lives in
 * `db/workflows.rs`.
 *
 * OBSERVABILITY — `job.status`: `src-tauri/src/obs.rs`'s `job_status` is one of
 * the "instrumented decision" call sites `obs.ts`'s own module doc defers to
 * "whichever feature ports it" (it is cross-cutting, not core logging
 * plumbing). This file is that feature, so it is ported here against `obs.ts`'s
 * already-committed primitives (`info`, `id`, `oneOf`, `errKind`). Every DB
 * write that changes a job's status logs through {@link logJobStatus}, gated on
 * the affected-row COUNT exactly as `db/jobs.rs` gates its own calls — a
 * transition that did not happen (an UPDATE matching no row) must not be
 * recorded as if it had, the same anti-fabrication rule the log applies to
 * everything else.
 *
 * The sink is an INJECTABLE {@link JobStatusLog} defaulting to the real
 * `obs.info`, rather than a hard reference to `obs.ts`'s process-wide
 * singleton: the Rust suite asserts on log CONTENT via `crate::obs::capture(||
 * ...)` — including that a job's own words (its title, an error naming a file)
 * never reach the log — and `obs.ts` has no `capture` seam of its own. With the
 * parameter, those privacy assertions port directly; without it they would have
 * been dropped, and the one guarantee this log exists to keep would be
 * untested. The parameter is last and defaulted, so no production call site
 * mentions it.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import { executeOne, queryOne, queryOpt, queryRows, type Row } from "./util.js";
import { finishWorkflowRunByJob } from "./workflows.js";
import { workIdentity } from "./jobIdentity.js";
import * as obs from "../obs.js";

/** A job row as the UI and runner see it. `plan` and `state` are opaque JSON
 * here; the runner owns their shape. Mirrors the Rust `Job` struct
 * (`#[serde(rename_all = "camelCase")]`). */
export interface Job {
  id: string;
  kind: string;
  title: string;
  plan: unknown;
  state: unknown;
  cursor: number;
  total: number;
  status: string;
  error: string | null;
  /** Wave 4a: set on a child job a workflow drives INLINE (a file_pass node).
   * pump/resume/quiesce and the Sidebar skip children — the parent holds the
   * lane slot and re-drives the child on its own resume, so a child must never
   * start (or be Resumed) independently. */
  parentJobId: string | null;
  /** Why this job stopped when nobody chose to stop it — the room was locked,
   * or the app closed, while it was still running. `null` means the pause was
   * the user's own (Stop), which is a different sentence in the UI. Cleared by
   * {@link setJobStatus} on every status that isn't 'paused', so a resumed or
   * finished job never keeps explaining an interruption it recovered from. */
  parkedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `JSON.parse`, falling back to `null` on a malformed blob — the Rust mappers'
 * `.unwrap_or(serde_json::Value::Null)`. */
function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const COLS =
  "id, kind, title, plan, state, cursor, total, status, error, " +
  "parent_job_id, parked_reason, created_at, updated_at";

function rowToJob(r: Row): Job {
  return {
    id: r[0] as string,
    kind: r[1] as string,
    title: r[2] as string,
    plan: parseJsonOrNull(r[3] as string),
    state: parseJsonOrNull(r[4] as string),
    cursor: r[5] as number,
    total: r[6] as number,
    status: r[7] as string,
    error: r[8] as string | null,
    parentJobId: r[9] as string | null,
    parkedReason: r[10] as string | null,
    createdAt: r[11] as string,
    updatedAt: r[12] as string,
  };
}

/** Insert a queued job with its immutable plan. Returns the new id. */
export function createJob(
  db: Database.Database,
  kind: string,
  title: string,
  plan: unknown,
  total: number
): string {
  return createJobInner(db, kind, title, plan, total, null);
}

/** Wave 4a: insert a CHILD job (a workflow's inline file_pass) tagged with its
 * parent so pump/resume/quiesce and the Sidebar skip it — the parent workflow
 * job owns its lifecycle. */
export function createChildJob(
  db: Database.Database,
  kind: string,
  title: string,
  plan: unknown,
  total: number,
  parentJobId: string
): string {
  return createJobInner(db, kind, title, plan, total, parentJobId);
}

function createJobInner(
  db: Database.Database,
  kind: string,
  title: string,
  plan: unknown,
  total: number,
  parentJobId: string | null
): string {
  // Enforce the one-parked-entry-per-unit-of-work rule at the single insert
  // funnel: a parked row this new job is about to redo is a stale attempt, not
  // a second thing the user is waiting on. Children are exempt — they are owned
  // by their parent, never listed, and never resumed on their own.
  if (parentJobId === null) {
    retireSupersededParked(db, kind, title, plan);
  }
  const id = randomUUID();
  executeOne(
    db,
    "INSERT INTO jobs(id, kind, title, plan, total, status, parent_job_id) " +
      "VALUES(?, ?, ?, ?, ?, 'queued', ?)",
    [id, kind, title, JSON.stringify(plan), total, parentJobId]
  );
  return id;
}

// ------------------------------------------------------- duplicate Activity rows

/** Every PARKED top-level job row, oldest first, paired with its identity.
 * Parked = the Activity group with nothing driving it, where the only offer is
 * Resume/Retry; `done` is deliberately outside it — a finished row is the
 * Activity HISTORY section's evidence that the work happened, and collapsing
 * two of those would quietly edit the record. Rows whose plan is unreadable are
 * skipped rather than lumped together — an unparseable plan is not evidence of
 * sameness. */
function parkedIdentities(db: Database.Database): Array<[string, string]> {
  const rows = queryRows(
    db,
    "SELECT id, kind, title, plan FROM jobs " +
      "WHERE parent_job_id IS NULL AND status IN ('paused','error') " +
      "ORDER BY created_at ASC, rowid ASC",
    [],
    (r) => [r[0] as string, r[1] as string, r[2] as string, r[3] as string] as const
  );
  const out: Array<[string, string]> = [];
  for (const [id, kind, title, planText] of rows) {
    let plan: unknown;
    try {
      plan = JSON.parse(planText);
    } catch {
      continue; // unreadable plan — skipped, matching the Rust `filter_map`.
    }
    out.push([id, workIdentity(kind, title, plan)]);
  }
  return out;
}

/** Delete a job and the children it owns. A child exists only to serve its
 * parent (the parent re-drives it on resume), so leaving one behind would
 * strand a row nothing lists, resumes or cleans up.
 *
 * One level deep, exactly like the Rust source: children are leaves (only a
 * workflow ever creates one, and it creates a `file_pass`), and recursing would
 * turn a corrupt row whose `parent_job_id` points at itself into unbounded
 * recursion. */
function deleteJobTree(db: Database.Database, id: string): void {
  const kids = queryRows(
    db,
    "SELECT id FROM jobs WHERE parent_job_id = ?",
    [id],
    (r) => r[0] as string
  );
  for (const kid of kids) {
    deleteJob(db, kid);
  }
  deleteJob(db, id);
}

/**
 * Drop the parked rows a job about to be created would redo. Called from the
 * insert funnel, so the rule that the repair applies to old rooms is the same
 * rule the write path keeps true from here on.
 *
 * A UNIQUE index would be the wrong tool: jobs legitimately repeat (a workflow
 * runs every morning, a file gets a second pass), and a partial index over the
 * parked statuses would turn `setJobStatus(.., "paused")` into an error the
 * moment a matching parked row existed — losing the checkpoint of a job the
 * user just stopped. The constraint belongs where a NEW row is minted, which is
 * the only moment we know the older one is superseded.
 */
function retireSupersededParked(
  db: Database.Database,
  kind: string,
  title: string,
  plan: unknown
): void {
  const want = workIdentity(kind, title, plan);
  for (const [id, identity] of parkedIdentities(db)) {
    if (identity === want) {
      deleteJobTree(db, id);
    }
  }
}

/**
 * One-time repair, run on every room open: collapse Activity rows that already
 * piled up before the write path enforced the rule above.
 *
 * For each `workIdentity` with more than one parked row, the NEWEST survives
 * and the older attempts go. Newest — not furthest-along — because that is the
 * same answer the insert funnel gives, and its plan is the one that matches the
 * room as it is now. The cost is real: an older copy's checkpoint is discarded.
 * That is why only PARKED, top-level, same-identity rows are eligible.
 *
 * Returns how many PARKED ENTRIES were retired — not how many rows the database
 * lost, which is larger whenever a retired parent owned children — so a caller
 * can report the truth rather than assume a clean sweep. Idempotent.
 */
export function dedupeParkedJobs(db: Database.Database): number {
  const seen = new Set<string>();
  // `parkedIdentities` is oldest-first; reversed, the FIRST time an identity is
  // seen is its newest row — the keeper.
  const rows = parkedIdentities(db).reverse();
  let removed = 0;
  for (const [id, identity] of rows) {
    if (!seen.has(identity)) {
      seen.add(identity);
      continue;
    }
    deleteJobTree(db, id);
    removed += 1;
  }
  return removed;
}

/** How many FINISHED runs of one unit of work the room keeps. */
const JOB_HISTORY_KEEP = 50;

/** How many closed `workflow_runs` rows the room keeps per workflow. The same
 * number `listWorkflowRuns` already caps its read at, so nothing this sweep
 * removes could still have been DRAWN. */
const RUN_HISTORY_KEEP = 50;

/** The `workflow_runs` half of {@link pruneJobHistory}: closed runs past the
 * newest {@link RUN_HISTORY_KEEP} of their workflow. An OPEN run (no
 * `finished_at`) is never touched — it is either live or the phantom the
 * callers close. */
function pruneWorkflowRuns(db: Database.Database): void {
  const rows = queryRows(
    db,
    "SELECT id, workflow_id FROM workflow_runs WHERE finished_at IS NOT NULL " +
      "ORDER BY started_at DESC, rowid DESC",
    [],
    (r) => [r[0] as string, r[1] as string] as const
  );
  const seen = new Map<string, number>();
  for (const [id, workflowId] of rows) {
    const n = (seen.get(workflowId) ?? 0) + 1;
    seen.set(workflowId, n);
    if (n > RUN_HISTORY_KEEP) {
      executeOne(db, "DELETE FROM workflow_runs WHERE id = ?", [id]);
    }
  }
}

/**
 * Roll the finished job history off the back, oldest first. Run on every room
 * open, the way `pruneWebCache` runs on every web-cache write.
 *
 * Nothing ever removed a finished job, its artifacts or a closed run row, so a
 * workflow on a 30-minute schedule grew the encrypted room file forever — and
 * `listJobs` deserialized every one of those rows' plans on every Activity
 * refresh.
 *
 * Only 'done', top-level rows are eligible, and only past the newest
 * {@link JOB_HISTORY_KEEP} of their own `workIdentity`: an 'error' or 'paused'
 * row is the Retry/Resume the user has not answered yet, and a row still named
 * by a surviving `workflow_runs` row is that run's evidence. Deletion goes
 * through {@link deleteJobTree}, so a swept parent takes its children and every
 * one of their artifacts with it. Returns how many TOP-LEVEL job rows were
 * removed.
 */
export function pruneJobHistory(db: Database.Database): number {
  pruneWorkflowRuns(db);

  const rows = queryRows(
    db,
    "SELECT id, kind, title, plan FROM jobs " +
      "WHERE parent_job_id IS NULL AND status = 'done' " +
      "AND id NOT IN (SELECT job_id FROM workflow_runs WHERE job_id IS NOT NULL) " +
      "ORDER BY created_at DESC, rowid DESC",
    [],
    (r) => [r[0] as string, r[1] as string, r[2] as string, r[3] as string] as const
  );

  const seen = new Map<string, number>();
  let removed = 0;
  for (const [id, kind, title, planText] of rows) {
    let plan: unknown;
    try {
      plan = JSON.parse(planText);
    } catch {
      continue; // an unreadable plan is not evidence of sameness — left alone.
    }
    const identity = workIdentity(kind, title, plan);
    const n = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, n);
    if (n > JOB_HISTORY_KEEP) {
      deleteJobTree(db, id);
      removed += 1;
    }
  }
  return removed;
}

/** Checkpoint after a step: advance the cursor and overwrite the state blob.
 * One small write, so a crash between steps loses at most the in-flight step. */
export function checkpointJob(
  db: Database.Database,
  id: string,
  cursor: number,
  state: unknown
): void {
  executeOne(
    db,
    "UPDATE jobs SET cursor = ?, state = ?, " +
      "updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
    [cursor, JSON.stringify(state), id]
  );
}

/** Stamp WHY a job paused itself, after {@link setJobStatus} has parked it.
 *
 * One caller: a chained clip that may not start because its predecessor's clip
 * does not exist yet. The reason is shown on the job card, and its prefix is
 * the marker the chain-waiter matches on — a user's own pause carries no such
 * reason and is never resumed behind their back. */
export function setParkedReason(db: Database.Database, id: string, reason: string): void {
  executeOne(db, "UPDATE jobs SET parked_reason = ? WHERE id = ? AND status = 'paused'", [
    reason,
    id,
  ]);
}

/** Every status a job row moves to — mirrors `obs.rs`'s `JOB_STATES`, the
 * whitelist {@link logJobStatus} narrows the `to` field onto. A value outside
 * it is recorded as `<unexpected>`, never as itself. */
export const JOB_STATES = ["queued", "running", "paused", "done", "error", "cancelled"] as const;

/** Where a job-status transition is announced. Defaults to the real host log
 * ({@link obs.info}); see this module's own doc comment for why it is a
 * parameter rather than a hard reference. */
export interface JobStatusLog {
  info: typeof obs.info;
}

const REAL_JOB_LOG: JobStatusLog = obs;

/** Port of `obs::job_status` — see this file's module doc for why it lives here
 * rather than in `obs.ts` itself. Neither the job's title nor its error message
 * travels: the error is classified onto `obs.ERR_KINDS`, and the id is an
 * opaque handle. */
function logJobStatus(
  log: JobStatusLog,
  jobId: string,
  to: string,
  error: string | null
): void {
  log.info("job.status", [
    ["job", obs.id(jobId)],
    ["to", obs.oneOf(to, JOB_STATES)],
    ["err", obs.errKind(error ?? "")],
  ]);
}

/**
 * Move a job to a terminal or paused status. `error` is set only for 'error'.
 *
 * Any status but 'paused' also clears `parked_reason`: a job that was stamped
 * "the room was locked while this was running" and then RESUMED (→ 'queued' →
 * 'running'), FINISHED (→ 'done') or hit a real failure (→ 'error') is no
 * longer describable by that interruption, and leaving the sentence behind
 * would make a recovered job keep reporting the crash it survived. 'paused' is
 * the one status that must preserve it — the epilogue of a job cancelled BY the
 * lock lands here, after {@link markJobParking} has already stamped why.
 */
export function setJobStatus(
  db: Database.Database,
  id: string,
  status: string,
  error: string | null,
  log: JobStatusLog = REAL_JOB_LOG
): void {
  const info =
    status === "paused"
      ? db
          .prepare(
            "UPDATE jobs SET status = ?, error = ?, " +
              "updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
          )
          .run(status, error, id)
      : db
          .prepare(
            "UPDATE jobs SET status = ?, error = ?, parked_reason = NULL, " +
              "updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
          )
          .run(status, error, id);
  // Every job transition a RUNNER makes goes through here, so recording it is
  // most of the history of a run — the thing that makes "it just stopped"
  // answerable. Gated on the affected-row count, not just "the statement ran":
  // an UPDATE matching no row is a successful statement that moved nothing, and
  // a log line saying a job went to 'done' when no such job exists is the same
  // lie in miniature that the whole anti-fabrication doctrine is about.
  if (info.changes > 0) {
    logJobStatus(log, id, status, error);
  }
}

/**
 * Stamp WHY a job is about to stop, without touching its status.
 *
 * Called while the room is still open and the runner is still alive, so
 * whichever way the runner lands afterwards the row can already say what
 * interrupted it: a runner that observes the cancel in time writes 'paused'
 * (which preserves this), one still inside a model call is forced to 'paused'
 * by {@link parkJob}, and one that actually FINISHES writes 'done' (which
 * clears it). Only rows still reading as live are stamped — a job already
 * parked or finished is not being interrupted by anything.
 */
export function markJobParking(db: Database.Database, id: string, reason: string): void {
  executeOne(
    db,
    "UPDATE jobs SET parked_reason = ? WHERE id = ? AND status IN ('running','queued')",
    [reason, id]
  );
}

/**
 * Park a job the app itself stopped: 'paused' plus the sentence saying why.
 *
 * Deliberately NOT a new status value. Every selector in the app already knows
 * the five statuses, and a sixth would have to be threaded through
 * {@link unfinishedJobs}, the queue pump and the dedupe sweep — the exact
 * places where treating a parked run as in-flight once left a workflow stuck
 * for good. A parked job is a PAUSED job that explains itself.
 *
 * Writes 'paused' DIRECTLY rather than through {@link setJobStatus}, to
 * preserve `parked_reason` — which is why it has to record its own transition:
 * without this line the parking path would be the one job transition the host
 * log could not see, and it is precisely the "it just stopped and nothing says
 * why" case. `reason` itself does NOT travel; it is a user-facing sentence, so
 * the event says a job was parked and the row keeps the wording.
 */
export function parkJob(
  db: Database.Database,
  id: string,
  reason: string,
  log: JobStatusLog = REAL_JOB_LOG
): void {
  const info = db
    .prepare(
      "UPDATE jobs SET status = 'paused', parked_reason = ?, " +
        "updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
    )
    .run(reason, id);
  if (info.changes > 0) {
    logJobStatus(log, id, "paused", null);
  }
}

export function getJob(db: Database.Database, id: string): Job {
  return queryOne(db, `SELECT ${COLS} FROM jobs WHERE id = ?`, [id], rowToJob);
}

/** All jobs, newest first — for the jobs panel. Wave 4a: children (a workflow's
 * inline file_pass) are hidden; their progress shows through the parent
 * workflow's animated pipeline, never a second sidebar card. */
export function listJobs(db: Database.Database): Job[] {
  return queryRows(
    db,
    `SELECT ${COLS} FROM jobs WHERE parent_job_id IS NULL ORDER BY created_at DESC`,
    [],
    rowToJob
  );
}

/**
 * Jobs that were mid-flight — 'running' or 'queued' or 'paused'. On app start
 * any 'running' row is really stale (the process that ran it is gone), so the
 * caller marks those 'paused' and offers Resume. Wave 4a: children are excluded
 * — they must never be pumped/resumed/quiesced independently of their parent.
 *
 * `created_at` has one-second resolution, so a scheduled run colliding with a
 * manual one leaves the FIFO order to whatever the sorter happens to do; the
 * `rowid` tiebreak states it instead, the same way `parkedIdentities` does.
 */
export function unfinishedJobs(db: Database.Database): Job[] {
  return queryRows(
    db,
    `SELECT ${COLS} FROM jobs ` +
      "WHERE status IN ('running','queued','paused') AND parent_job_id IS NULL " +
      "ORDER BY created_at ASC, rowid ASC",
    [],
    rowToJob
  );
}

export function deleteJob(db: Database.Database, id: string): void {
  // A workflow job also drives a `workflow_runs` row, and nothing but the
  // runner's own epilogue ever closed one. Deleting the job left that row open
  // forever: the library card kept its green "Running" badge and Run history
  // printed a live run with no `finished_at` for work whose job no longer
  // exists. Closing it as 'paused' is what the card already reads as "Stopped".
  // A no-op for every other job kind — they have no run row.
  try {
    finishWorkflowRunByJob(db, id, "paused", null);
  } catch {
    // best-effort, mirrors the Rust `let _ = crate::db::finish_workflow_run_by_job(...)`
  }
  executeOne(db, "DELETE FROM job_artifacts WHERE job_id = ?", [id]);
  executeOne(db, "DELETE FROM jobs WHERE id = ?", [id]);
}

// ---------------------------------------------------------------- artifacts

/**
 * ADD-32: save one step's output. INSERT OR REPLACE so a step re-run after a
 * crash (artifact written, cursor not yet advanced) is idempotent.
 *
 * The `WHERE EXISTS` clause is load-bearing: a job deleted mid-run (Delete on a
 * running workflow) keeps going for one more step, and without the guard that
 * step's artifact would be written under a job id that no longer exists —
 * invisible rows nothing ever cleans up. A dropped write is exactly right:
 * there is no longer a job to read it.
 */
export function putJobArtifact(
  db: Database.Database,
  jobId: string,
  stepId: number,
  content: string
): void {
  executeOne(
    db,
    "INSERT OR REPLACE INTO job_artifacts(job_id, step_id, content) " +
      "SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ?)",
    [jobId, stepId, content, jobId]
  );
}

export function getJobArtifact(
  db: Database.Database,
  jobId: string,
  stepId: number
): string | null {
  return queryOpt(
    db,
    "SELECT content FROM job_artifacts WHERE job_id = ? AND step_id = ?",
    [jobId, stepId],
    (r) => r[0] as string
  );
}
