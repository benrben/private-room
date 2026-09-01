/**
 * Vitest port of the `db/workflows.rs` tests (`src-tauri/src/db/workflows.rs`,
 * `mod tests`):
 *
 *   - workflow_crud_roundtrip_and_cascade
 *   - schedule_upsert_replaces_and_due_reads_only_active_enabled
 *
 * NOT ported: `migration_adds_workflow_tables_and_columns_to_a_pre_wave_room`
 * pins `schema.rs`'s `migrate()`, which is `db-host/migrate.ts`'s territory
 * (already committed, already tested there), not this batch's. This port's
 * fixture room is built straight from the current `schema.sql` (via
 * {@link createRoom}), which already ships the `workflows`/`workflow_runs`/
 * `schedules` tables and `jobs.parent_job_id` — there is no pre-wave schema to
 * migrate FROM here.
 *
 * DEVIATION from the Rust test module: it uses a hand-rolled `super::mem()`
 * in-memory `Connection`; this port uses the established real-fixture-room
 * convention (`createRoom`, see `chats.test.ts`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./open.js";
import { createJob, deleteJob, setJobStatus } from "./jobs.js";
import {
  createWorkflow,
  createWorkflowRun,
  deleteWorkflow,
  dueSchedules,
  findWorkflow,
  finishWorkflowRunByJob,
  getSchedule,
  getWorkflow,
  listWorkflowRuns,
  listWorkflows,
  markScheduleRun,
  setScheduleNextRun,
  setWorkflowPinned,
  setWorkflowRunStatusByJob,
  setWorkflowStatus,
  updateWorkflow,
  upsertSchedule,
} from "./workflows.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-workflows-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function def(): unknown {
  return { version: 1, nodes: [], edges: [] };
}

describe("workflow CRUD + run/schedule cascade", () => {
  it("workflow_crud_roundtrip_and_cascade", () => {
    const db = freshRoom();
    const id = createWorkflow(db, "Morning digest", "a daily digest", "🌅", def(), "user", {
      scope: "general",
    });
    let w = getWorkflow(db, id);
    expect(w.name).toBe("Morning digest");
    expect(w.status, "activation is an explicit user act").toBe("draft");
    expect(w.createdBy).toBe("user");
    expect(w.pinned).toBe(false);
    expect((w.binding as { scope: string }).scope).toBe("general");

    setWorkflowStatus(db, id, "active");
    setWorkflowPinned(db, id, true);
    w = getWorkflow(db, id);
    expect(w.status).toBe("active");
    expect(w.pinned).toBe(true);

    // findWorkflow resolves by id, exact name and case-insensitive fragment.
    expect(findWorkflow(db, id).id).toBe(id);
    expect(findWorkflow(db, "Morning digest").id).toBe(id);
    expect(findWorkflow(db, "morning").id).toBe(id);
    expect(() => findWorkflow(db, "nope")).toThrow(/No workflow named/);

    // A run + schedule cascade-delete with the workflow.
    const run = createWorkflowRun(db, id, "job1", "manual", "file1");
    upsertSchedule(db, id, "daily", "08:00", true, true, "2026-07-19T08:00:00Z");
    expect(listWorkflowRuns(db, id).length).toBe(1);
    expect(getSchedule(db, id)).not.toBeNull();

    // Pausing re-labels the OPEN run without closing it, so a later resume can
    // still finish it properly.
    setWorkflowRunStatusByJob(db, "job1", "paused");
    let runs = listWorkflowRuns(db, id);
    expect(runs[0]?.status).toBe("paused");
    expect(runs[0]?.finishedAt, "a pause is not a finish").toBeNull();

    finishWorkflowRunByJob(db, "job1", "done", null);
    runs = listWorkflowRuns(db, id);
    expect(runs[0]?.id).toBe(run);
    expect(runs[0]?.status).toBe("done");
    expect(runs[0]?.finishedAt).not.toBeNull();
    expect(runs[0]?.inputFileId).toBe("file1");
    // A finished run is closed for good — a stray pause can't reopen it.
    setWorkflowRunStatusByJob(db, "job1", "paused");
    expect(listWorkflowRuns(db, id)[0]?.status).toBe("done");

    deleteWorkflow(db, id);
    expect(() => getWorkflow(db, id)).toThrow();
    expect(listWorkflowRuns(db, id)).toEqual([]);
    expect(getSchedule(db, id)).toBeNull();
    db.close();
  });

  it("an edit rewrites the definition and binding, and listing is newest-first", () => {
    const db = freshRoom();
    const a = createWorkflow(db, "A", "", "", def(), "user", { scope: "general" });
    const b = createWorkflow(db, "B", "", "", def(), "agent", { scope: "general" });

    updateWorkflow(db, a, "A renamed", "now with a description", "📬", { version: 2, nodes: [1] }, {
      scope: "file",
      kind: "pdf",
    });
    const w = getWorkflow(db, a);
    expect(w.name).toBe("A renamed");
    expect(w.description).toBe("now with a description");
    expect(w.emoji).toBe("📬");
    expect((w.definition as { version: number }).version).toBe(2);
    expect((w.binding as { kind: string }).kind).toBe("pdf");
    // The edit bumped `updated_at`, and the list is ordered by it.
    expect(listWorkflows(db).map((x) => x.id)).toEqual([a, b]);
    db.close();
  });

  it("reads malformed legacy JSON as the documented safe defaults", () => {
    const db = freshRoom();
    const id = createWorkflow(db, "legacy", "", "", def(), "user", { scope: "file" });
    db.prepare("UPDATE workflows SET definition = 'bad', binding = 'bad' WHERE id = ?").run(id);
    const workflow = getWorkflow(db, id);
    expect(workflow.definition).toBeNull();
    expect(workflow.binding).toEqual({ scope: "general" });
    db.close();
  });
});

describe("schedules", () => {
  it("schedule_upsert_replaces_and_due_reads_only_active_enabled", () => {
    const db = freshRoom();
    const id = createWorkflow(db, "wf", "", "", def(), "user", { scope: "general" });

    // A draft workflow's due schedule is NOT returned.
    upsertSchedule(db, id, "interval", "30", true, false, "2000-01-01T00:00:00Z");
    expect(dueSchedules(db, "2030-01-01T00:00:00Z")).toEqual([]);

    // Activate it → now due, and the workflow half of the row is complete.
    setWorkflowStatus(db, id, "active");
    const due = dueSchedules(db, "2030-01-01T00:00:00Z");
    expect(due.length).toBe(1);
    expect(due[0]?.[0].kind).toBe("interval");
    expect(due[0]?.[0].catchUp).toBe(false);
    expect(due[0]?.[1].id).toBe(id);
    expect(due[0]?.[1].name, "the joined workflow columns are read, not just its id").toBe("wf");
    expect(due[0]?.[1].status).toBe("active");

    // upsert REPLACES (one schedule per workflow), and disabling hides it.
    upsertSchedule(db, id, "daily", "09:00", false, true, "2000-01-01T00:00:00Z");
    const rows = db.prepare("SELECT count(*) as n FROM schedules").get() as { n: number };
    expect(rows.n, "one schedule row per workflow").toBe(1);
    expect(getSchedule(db, id)?.kind).toBe("daily");
    expect(dueSchedules(db, "2030-01-01T00:00:00Z")).toEqual([]);

    // A future next_run_at is not yet due.
    upsertSchedule(db, id, "daily", "09:00", true, true, "2999-01-01T00:00:00Z");
    expect(dueSchedules(db, "2030-01-01T00:00:00Z")).toEqual([]);

    // markScheduleRun advances next_run_at and records the job.
    const schedId = getSchedule(db, id)?.id as string;
    markScheduleRun(db, schedId, "jobX", "3000-01-01T00:00:00Z");
    let s = getSchedule(db, id);
    expect(s?.lastJobId).toBe("jobX");
    expect(s?.lastRunAt).not.toBeNull();
    expect(s?.nextRunAt).toBe("3000-01-01T00:00:00Z");

    // setScheduleNextRun advances WITHOUT recording a run (the skip path), and
    // an upsert over an existing row keeps that row's id and last_run_at.
    setScheduleNextRun(db, schedId, "3001-01-01T00:00:00Z");
    upsertSchedule(db, id, "daily", "10:00", true, true, "3002-01-01T00:00:00Z");
    s = getSchedule(db, id);
    expect(s?.id, "the row id survives an upsert").toBe(schedId);
    expect(s?.lastJobId, "the skip path records no run").toBe("jobX");
    expect(s?.nextRunAt).toBe("3002-01-01T00:00:00Z");

    // A NULL next_run_at never fires — it means "compute a next run first".
    setScheduleNextRun(db, schedId, null);
    expect(getSchedule(db, id)?.nextRunAt).toBeNull();
    expect(dueSchedules(db, "3030-01-01T00:00:00Z")).toEqual([]);

    // Clearing (kind = "") deletes.
    upsertSchedule(db, id, "", "", true, true, null);
    expect(getSchedule(db, id)).toBeNull();
    db.close();
  });
});

describe("deleteJob closes a workflow's run row (jobs.ts <-> workflows.ts wiring)", () => {
  it("delete_job's finish_workflow_run_by_job call actually reaches this table", () => {
    // `db/jobs.rs`'s `delete_job` calls `crate::db::finish_workflow_run_by_job`
    // directly — a cross-module call this port keeps by importing
    // `finishWorkflowRunByJob` into `jobs.ts`. Exercised for real here (rather
    // than only inside `jobs.test.ts`) because it is the one place the two
    // ported files actually touch each other.
    const db = freshRoom();
    const wfId = createWorkflow(db, "wf", "", "", def(), "user", { scope: "general" });
    const jobId = createJob(db, "workflow", "Workflow — wf", { workflow_id: wfId }, 2);
    createWorkflowRun(db, wfId, jobId, "manual", null);
    setJobStatus(db, jobId, "running", null);

    deleteJob(db, jobId);

    const runs = listWorkflowRuns(db, wfId);
    expect(runs[0]?.status).toBe("paused");
    expect(runs[0]?.finishedAt, "the run row must be closed, not left open").not.toBeNull();
    db.close();
  });
});
