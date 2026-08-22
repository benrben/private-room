/**
 * Wave 4a (Idea 2): persistence for LLM graph workflows, their run history, and
 * their schedules. Pure DB plumbing — the definition format, compiler and
 * executor live in a future batch's `commands/jobs/workflow.rs` port; the tick
 * loop that READS `dueSchedules` is `../jobScheduler.ts`, ported in this batch.
 *
 * Ported from `src-tauri/src/db/workflows.rs` (586 lines, including its
 * `#[cfg(test)] mod tests`).
 *
 * `definition` and `binding` are stored as JSON text but surface to the caller
 * as parsed values, so nothing above this file re-parses them.
 *
 * ESTABLISHED CONVENTIONS reused from `util.ts`'s module comment: every
 * read/write goes through `queryOne`/`queryOpt`/`queryRows`/`executeOne` rather
 * than a bare `db.prepare` call site; rows are read positionally via `.raw()`
 * (`Row`), matching the Rust mappers' `r.get(i)` order column-for-column; a
 * reused Rust `?1` becomes a `?` repeated in the params array; a `Result<T,
 * String>` becomes a thrown `Error`.
 *
 * DEVIATION — `upsertSchedule`'s existence check: the Rust source's `existing`
 * tuple also selects `last_run_at` but only ever reads the `id` half (the other
 * is bound to `_`) — this port's SELECT just asks for `id`, which is the only
 * column the decision (`UPDATE` vs `INSERT`) depends on.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { randomUUID } from "node:crypto";
import { executeOne, queryOne, queryOpt, queryRows, type Row } from "./util.js";

/** Mirrors the Rust `Workflow` struct (`#[serde(rename_all = "camelCase")]`).
 * `definition` is the immutable WorkflowDef JSON; `binding` scopes where it
 * surfaces (general vs file-kind — shortcuts extension). */
export interface Workflow {
  id: string;
  name: string;
  description: string;
  emoji: string;
  definition: unknown;
  status: string;
  createdBy: string;
  binding: unknown;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One execution of a workflow — its trigger, the job it drove, and how it
 * ended. Mirrors the Rust `WorkflowRun` struct. */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  jobId: string | null;
  trigger: string;
  status: string;
  error: string | null;
  inputFileId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** A workflow's schedule. `kind` = interval|daily|weekly; `param` encodes the
 * preset (minutes, "HH:MM", or "DOW HH:MM"). Only ACTIVE workflows with an
 * ENABLED schedule are ever fired by the tick loop. Mirrors the Rust
 * `Schedule` struct. */
export interface Schedule {
  id: string;
  workflowId: string;
  kind: string;
  param: string;
  enabled: boolean;
  catchUp: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastJobId: string | null;
}

/** `JSON.parse`, falling back to `fallback` on a malformed blob — the direct
 * equivalent of the Rust mappers' `.unwrap_or(Value::Null)` /
 * `.unwrap_or_else(|_| json!({"scope": "general"}))`. */
function parseJsonOr<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const WF_COLS =
  "id, name, description, emoji, definition, status, created_by, " +
  "binding, pinned, created_at, updated_at";

function rowToWorkflow(r: Row): Workflow {
  return {
    id: r[0] as string,
    name: r[1] as string,
    description: r[2] as string,
    emoji: r[3] as string,
    definition: parseJsonOr(r[4] as string, null),
    status: r[5] as string,
    createdBy: r[6] as string,
    binding: parseJsonOr(r[7] as string, { scope: "general" }),
    pinned: (r[8] as number) !== 0,
    createdAt: r[9] as string,
    updatedAt: r[10] as string,
  };
}

/** Insert a new workflow (always as a draft — activation is an explicit user
 * act). Returns the new id. */
export function createWorkflow(
  db: Database.Database,
  name: string,
  description: string,
  emoji: string,
  definition: unknown,
  createdBy: string,
  binding: unknown
): string {
  const id = randomUUID();
  executeOne(
    db,
    "INSERT INTO workflows(id, name, description, emoji, definition, status, created_by, binding) " +
      "VALUES(?, ?, ?, ?, ?, 'draft', ?, ?)",
    [id, name, description, emoji, JSON.stringify(definition), createdBy, JSON.stringify(binding)]
  );
  return id;
}

/** Overwrite a workflow's editable fields and bump `updated_at`. The caller
 * decides the status transition (an edit to an active workflow drops it to
 * draft — the review gate). */
export function updateWorkflow(
  db: Database.Database,
  id: string,
  name: string,
  description: string,
  emoji: string,
  definition: unknown,
  binding: unknown
): void {
  executeOne(
    db,
    "UPDATE workflows SET name = ?, description = ?, emoji = ?, definition = ?, " +
      "binding = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
    [name, description, emoji, JSON.stringify(definition), JSON.stringify(binding), id]
  );
}

export function setWorkflowStatus(db: Database.Database, id: string, status: string): void {
  executeOne(
    db,
    "UPDATE workflows SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
    [status, id]
  );
}

export function setWorkflowPinned(db: Database.Database, id: string, pinned: boolean): void {
  executeOne(
    db,
    "UPDATE workflows SET pinned = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?",
    [pinned ? 1 : 0, id]
  );
}

export function getWorkflow(db: Database.Database, id: string): Workflow {
  return queryOne(db, `SELECT ${WF_COLS} FROM workflows WHERE id = ?`, [id], rowToWorkflow);
}

/** Resolve a name-or-id to a workflow (exact id first, then exact name, then a
 * case-insensitive name fragment — the agent passes names, the UI passes
 * ids). */
export function findWorkflow(db: Database.Database, nameOrId: string): Workflow {
  try {
    return getWorkflow(db, nameOrId);
  } catch {
    // Not an id (or not one that exists) — fall through to a name search.
  }
  const like = `%${nameOrId.toLowerCase()}%`;
  try {
    return queryOne(
      db,
      `SELECT ${WF_COLS} FROM workflows ` +
        "WHERE lower(name) = lower(?) OR lower(name) LIKE ? " +
        "ORDER BY (lower(name) = lower(?)) DESC, updated_at DESC LIMIT 1",
      [nameOrId, like, nameOrId],
      rowToWorkflow
    );
  } catch {
    throw new Error(`No workflow named "${nameOrId}" was found.`);
  }
}

export function listWorkflows(db: Database.Database): Workflow[] {
  return queryRows(db, `SELECT ${WF_COLS} FROM workflows ORDER BY updated_at DESC`, [], rowToWorkflow);
}

export function deleteWorkflow(db: Database.Database, id: string): void {
  // schedules + workflow_runs cascade via their FK (foreign_keys=ON).
  executeOne(db, "DELETE FROM workflows WHERE id = ?", [id]);
}

// ------------------------------------------------------------------ runs

const RUN_COLS =
  "id, workflow_id, job_id, trigger, status, error, input_file_id, started_at, finished_at";

function rowToRun(r: Row): WorkflowRun {
  return {
    id: r[0] as string,
    workflowId: r[1] as string,
    jobId: r[2] as string | null,
    trigger: r[3] as string,
    status: r[4] as string,
    error: r[5] as string | null,
    inputFileId: r[6] as string | null,
    startedAt: r[7] as string,
    finishedAt: r[8] as string | null,
  };
}

/** Open a run row when a workflow starts. Returns the run id. */
export function createWorkflowRun(
  db: Database.Database,
  workflowId: string,
  jobId: string,
  trigger: string,
  inputFileId: string | null
): string {
  const id = randomUUID();
  executeOne(
    db,
    "INSERT INTO workflow_runs(id, workflow_id, job_id, trigger, status, input_file_id) " +
      "VALUES(?, ?, ?, ?, 'running', ?)",
    [id, workflowId, jobId, trigger, inputFileId]
  );
  return id;
}

/** Re-label an OPEN run without closing it — the pause path. A run whose job
 * was parked (Stop, or a quit mid-run) is neither running nor finished, and
 * leaving it 'running' made the history line show a green live dot forever and
 * made every later run look like a duplicate. */
export function setWorkflowRunStatusByJob(
  db: Database.Database,
  jobId: string,
  status: string
): void {
  executeOne(
    db,
    "UPDATE workflow_runs SET status = ? WHERE job_id = ? AND finished_at IS NULL",
    [status, jobId]
  );
}

/** Close a run by its driving job id — the terminal epilogue knows the job id,
 * not the run id. */
export function finishWorkflowRunByJob(
  db: Database.Database,
  jobId: string,
  status: string,
  error: string | null
): void {
  executeOne(
    db,
    "UPDATE workflow_runs SET status = ?, error = ?, " +
      "finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') " +
      "WHERE job_id = ? AND finished_at IS NULL",
    [status, error, jobId]
  );
}

export function listWorkflowRuns(db: Database.Database, workflowId: string): WorkflowRun[] {
  return queryRows(
    db,
    `SELECT ${RUN_COLS} FROM workflow_runs WHERE workflow_id = ? ` +
      "ORDER BY started_at DESC LIMIT 50",
    [workflowId],
    rowToRun
  );
}

// ------------------------------------------------------------------ schedules

const SCHED_COLS =
  "id, workflow_id, kind, param, enabled, catch_up, next_run_at, last_run_at, last_job_id";

/** How many columns {@link SCHED_COLS} names — where the workflow half of a
 * {@link dueSchedules} row starts. Derived, never hand-counted: the Rust
 * source's own "Workflow columns begin at index 9" comment is a magic number
 * that would go silently wrong the moment either column list changed. */
const SCHED_COL_COUNT = SCHED_COLS.split(", ").length;

function rowToSchedule(r: Row): Schedule {
  return {
    id: r[0] as string,
    workflowId: r[1] as string,
    kind: r[2] as string,
    param: r[3] as string,
    enabled: (r[4] as number) !== 0,
    catchUp: (r[5] as number) !== 0,
    nextRunAt: r[6] as string | null,
    lastRunAt: r[7] as string | null,
    lastJobId: r[8] as string | null,
  };
}

/** One schedule per workflow — insert or replace it. Passing `kind === ""`
 * clears the schedule (delete). `nextRunAt` is computed by the caller. */
export function upsertSchedule(
  db: Database.Database,
  workflowId: string,
  kind: string,
  param: string,
  enabled: boolean,
  catchUp: boolean,
  nextRunAt: string | null
): void {
  if (kind === "") {
    executeOne(db, "DELETE FROM schedules WHERE workflow_id = ?", [workflowId]);
    return;
  }
  // Preserve the existing row id (and with it `last_run_at`) if there is one —
  // see this file's module comment for why only `id` is read here.
  const existingId = queryOpt(
    db,
    "SELECT id FROM schedules WHERE workflow_id = ?",
    [workflowId],
    (r) => r[0] as string
  );
  if (existingId !== null) {
    executeOne(
      db,
      "UPDATE schedules SET kind = ?, param = ?, enabled = ?, catch_up = ?, " +
        "next_run_at = ? WHERE id = ?",
      [kind, param, enabled ? 1 : 0, catchUp ? 1 : 0, nextRunAt, existingId]
    );
    return;
  }
  const id = randomUUID();
  executeOne(
    db,
    "INSERT INTO schedules(id, workflow_id, kind, param, enabled, catch_up, next_run_at) " +
      "VALUES(?, ?, ?, ?, ?, ?, ?)",
    [id, workflowId, kind, param, enabled ? 1 : 0, catchUp ? 1 : 0, nextRunAt]
  );
}

export function getSchedule(db: Database.Database, workflowId: string): Schedule | null {
  return queryOpt(
    db,
    `SELECT ${SCHED_COLS} FROM schedules WHERE workflow_id = ?`,
    [workflowId],
    rowToSchedule
  );
}

/** The scheduler's read: every ENABLED schedule of an ACTIVE workflow whose
 * `next_run_at` is due (`null` never fires — it means "compute a next run
 * first"). Returns (schedule, workflow) pairs so the tick can compile without a
 * second query. `now` is an ISO8601 string; string comparison is valid because
 * timestamps are stored zero-padded. */
export function dueSchedules(db: Database.Database, now: string): Array<[Schedule, Workflow]> {
  const schedCols = SCHED_COLS.split(", ")
    .map((c) => `s.${c}`)
    .join(", ");
  const wfCols = WF_COLS.split(", ")
    .map((c) => `w.${c}`)
    .join(", ");
  return queryRows(
    db,
    `SELECT ${schedCols}, ${wfCols} FROM schedules s ` +
      "JOIN workflows w ON w.id = s.workflow_id " +
      "WHERE s.enabled = 1 AND w.status = 'active' " +
      "AND s.next_run_at IS NOT NULL AND s.next_run_at <= ?",
    [now],
    (r): [Schedule, Workflow] => [rowToSchedule(r), rowToWorkflow(r.slice(SCHED_COL_COUNT))]
  );
}

/** Advance a schedule's `next_run_at` WITHOUT recording a run (the catch-up
 * skip path: a missed run whose workflow opted out of catch-up). */
export function setScheduleNextRun(
  db: Database.Database,
  scheduleId: string,
  nextRunAt: string | null
): void {
  executeOne(db, "UPDATE schedules SET next_run_at = ? WHERE id = ?", [nextRunAt, scheduleId]);
}

/** After firing (or catching up), record the run and advance `next_run_at`. */
export function markScheduleRun(
  db: Database.Database,
  scheduleId: string,
  jobId: string,
  nextRunAt: string | null
): void {
  executeOne(
    db,
    "UPDATE schedules SET last_run_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), " +
      "last_job_id = ?, next_run_at = ? WHERE id = ?",
    [jobId, nextRunAt, scheduleId]
  );
}
