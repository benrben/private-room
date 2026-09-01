/**
 * Vitest port of the `db/jobs.rs` tests (`src-tauri/src/db/jobs.rs`, `mod
 * tests`) — all sixteen of them:
 *
 *   - every_job_transition_is_recorded_and_carries_no_content
 *   - a_transition_that_did_not_happen_is_not_logged_as_if_it_had
 *   - a_job_the_app_parked_is_recorded_like_any_other_transition
 *   - artifacts_roundtrip_and_die_with_the_job
 *   - an_artifact_for_a_deleted_job_is_never_written
 *   - create_checkpoint_resume_roundtrip
 *   - auto_flags_roundtrip_through_the_plan_json
 *   - child_jobs_are_hidden_from_lists_and_the_pump
 *   - repair_keeps_one_parked_row_per_unit_of_work
 *   - repair_is_a_no_op_on_a_clean_table
 *   - failed_auto_index_attempts_collapse_but_named_summaries_do_not
 *   - creating_a_job_retires_only_the_parked_attempt_it_repeats
 *   - the_parking_reason_survives_a_pause_and_nothing_else
 *   - park_job_leaves_the_row_resumable_by_every_existing_selector
 *   - deleting_a_workflow_job_closes_its_run_row
 *   - finished_history_rolls_off_but_live_and_evidenced_rows_stay
 *   - closed_run_rows_roll_off_per_workflow_and_open_ones_never_do
 *   - error_status_carries_a_message
 *
 * The three log-CONTENT tests port directly because `setJobStatus`/`parkJob`
 * take an injectable {@link JobStatusLog} — `captureLog` below is this port's
 * `crate::obs::capture(|| ...)`, without touching `obs.ts`'s process-wide
 * singleton (which only exists after `obs.init()` and writes to the real OS
 * temp directory; `obs.test.ts` builds its own sinks for the same reason).
 * Those are the tests that pin the PRIVACY guarantee — a job's title and the
 * filenames inside its error never reach the log — so dropping them would have
 * left the one thing that log exists to promise untested.
 *
 * NOT PORTED: `migration_adds_workflow_tables_and_columns_to_a_pre_wave_room`
 * lives in `workflows.rs`'s test module and exercises `migrate.ts`, a
 * pre-existing file outside this batch.
 *
 * FIXTURE DEVIATION from the Rust test module: real rooms via `createRoom`
 * (this directory's convention — see `chats.test.ts`), rather than the ad hoc
 * `jobs`/`job_artifacts`/`workflow_runs` triple `db/jobs.rs` hand-rolls. The
 * real `schema.sql` enforces foreign keys, so wherever a Rust test names a
 * `workflow_id` that was never inserted, `legacyWorkflow` inserts the parent
 * row first — the assertions are unchanged.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import * as obs from "../obs.js";
import { createRoom } from "./open.js";
import {
  checkpointJob,
  createChildJob,
  createJob,
  dedupeParkedJobs,
  deleteJob,
  getJob,
  getJobArtifact,
  JOB_STATES,
  type JobStatusLog,
  listJobs,
  markJobParking,
  parkJob,
  pruneJobHistory,
  putJobArtifact,
  setJobStatus,
  setParkedReason,
  unfinishedJobs,
} from "./jobs.js";
import { createWorkflowRun } from "./workflows.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "db-host-jobs-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

/** A recording {@link JobStatusLog} — this port's `crate::obs::capture`. */
function captureLog(): { log: JobStatusLog; lines: string[] } {
  const lines: string[] = [];
  const record = (event: string, fields: ReadonlyArray<readonly [string, obs.Val]>): void => {
    lines.push(`${event} ${fields.map(([k, v]) => `${k}=${v.toString()}`).join(" ")}`.trim());
  };
  return { log: { info: record as unknown as typeof obs.info }, lines };
}

/** Insert a job row directly, bypassing `createJob`'s supersede guard, so a
 * test can build the pile-up an old room actually holds — mirrors the Rust
 * suite's own `legacy_job` helper. */
function legacyJob(
  db: Database.Database,
  id: string,
  kind: string,
  title: string,
  plan: unknown,
  status: string,
  createdAt: string
): void {
  db.prepare(
    "INSERT INTO jobs(id, kind, title, plan, total, status, created_at) " +
      "VALUES (?, ?, ?, ?, 3, ?, ?)"
  ).run(id, kind, title, JSON.stringify(plan), status, createdAt);
}

/** Insert a minimal `workflows` row with an explicit id — the fixture rooms
 * here use the REAL schema (foreign keys ON), so `workflow_runs.workflow_id`
 * needs a real parent row before it can be referenced. */
function legacyWorkflow(db: Database.Database, id: string, name: string): void {
  db.prepare("INSERT INTO workflows(id, name, definition) VALUES (?, ?, '{}')").run(id, name);
}

function ids(db: Database.Database): string[] {
  return db
    .prepare("SELECT id FROM jobs ORDER BY id")
    .all()
    .map((r) => (r as { id: string }).id);
}

describe("the job.status transition log", () => {
  it("every_job_transition_is_recorded_and_carries_no_content", () => {
    // `setJobStatus` is the one choke point every status change goes through,
    // so the host log's record of it IS the job's history. The title/error a
    // job carries are room content, so the event must be able to name the
    // transition without naming them.
    const db = freshRoom();
    const id = createJob(db, "file_pass", "Full pass — Divorce settlement.docx", {}, 3);
    const { log, lines } = captureLog();
    setJobStatus(db, id, "running", null, log);
    setJobStatus(db, id, "paused", null, log);
    setJobStatus(db, id, "error", "No such file or directory: /Users/ben/Divorce settlement.docx", log);

    const joined = lines.join("\n");
    expect(lines.filter((l) => l.startsWith("job.status")).length).toBe(3);
    expect(joined).toContain(`job=${id} to=running`);
    expect(joined).toContain(`job=${id} to=paused`);
    expect(joined).toContain(`job=${id} to=error err=not_found`);
    expect(joined, "the job's own words leaked").not.toContain("Divorce");
    expect(joined, "the job's own words leaked").not.toContain("settlement");
    db.close();
  });

  it("a_transition_that_did_not_happen_is_not_logged_as_if_it_had", () => {
    // Anti-fabrication, applied to our own log. An UPDATE matching no row is a
    // perfectly successful statement, so "the write succeeded" is NOT evidence
    // that a job moved.
    const db = freshRoom();
    const { log, lines } = captureLog();
    expect(
      () => setJobStatus(db, "no-such-job", "done", null, log),
      "pre-existing behaviour: a no-op UPDATE is not an error"
    ).not.toThrow();
    expect(lines.some((l) => l.startsWith("job.status")), "a phantom transition was logged").toBe(
      false
    );
    db.close();
  });

  it("a_job_the_app_parked_is_recorded_like_any_other_transition", () => {
    // `parkJob` writes 'paused' DIRECTLY (it has to, to preserve
    // `parked_reason`), so it never reaches `setJobStatus` — and a job the APP
    // stopped is the single case most likely to be reported as "it just
    // stopped and nothing said why". The parking REASON is a user-facing
    // sentence and must not travel; the transition must.
    const db = freshRoom();
    const id = createJob(db, "file_pass", "Full pass — Divorce settlement.docx", {}, 3);
    setJobStatus(db, id, "running", null);
    const { log, lines } = captureLog();
    parkJob(db, id, "The room was locked while this was still running.", log);

    const joined = lines.join("\n");
    expect(joined).toContain(`job=${id} to=paused`);
    for (const word of ["locked", "room", "Divorce", "settlement"]) {
      expect(joined, `${word} leaked`).not.toContain(word);
    }

    const { log: log2, lines: lines2 } = captureLog();
    parkJob(db, "no-such-job", "whatever", log2);
    expect(lines2.some((l) => l.startsWith("job.status")), "a phantom parking was logged").toBe(
      false
    );
    db.close();
  });

  it("matches the status vocabulary every selector already knows", () => {
    expect(JOB_STATES).toEqual(["queued", "running", "paused", "done", "error", "cancelled"]);
  });
});

describe("checkpoint / resume", () => {
  it("create_checkpoint_resume_roundtrip", () => {
    const db = freshRoom();
    const plan = { steps: [1, 2, 3] };
    const id = createJob(db, "deep_summary", "big.pdf", plan, 3);

    // Fresh job: queued, cursor 0.
    let j = getJob(db, id);
    expect(j.status).toBe("queued");
    expect(j.cursor).toBe(0);
    expect(j.total).toBe(3);
    expect(j.plan).toEqual(plan);

    setJobStatus(db, id, "running", null);
    checkpointJob(db, id, 1, { points: ["a"] });
    checkpointJob(db, id, 2, { points: ["a", "b"] });

    // Simulate a crash: the row is still 'running'. unfinishedJobs sees it.
    const unfinished = unfinishedJobs(db);
    expect(unfinished.length).toBe(1);
    j = unfinished[0] as (typeof unfinished)[number];
    expect(j.cursor, "resume from step 2").toBe(2);
    expect((j.state as { points: string[] }).points).toEqual(["a", "b"]);

    checkpointJob(db, id, 3, j.state);
    setJobStatus(db, id, "done", null);
    expect(unfinishedJobs(db)).toEqual([]);
    expect(getJob(db, id).status).toBe("done");
    db.close();
  });

  it("auto_flags_roundtrip_through_the_plan_json", () => {
    // `resume` re-reads `auto`/`reduce` from the stored plan — they must
    // survive createJob/getJob byte-exactly.
    const db = freshRoom();
    const id = createJob(db, "deep_summary", "Indexing new files", { steps: [], auto: true, reduce: false }, 7);
    const j = getJob(db, id);
    expect(j.title).toBe("Indexing new files");
    expect((j.plan as { auto: boolean }).auto).toBe(true);
    expect((j.plan as { reduce: boolean }).reduce).toBe(false);

    // A manual job's plan simply lacks the flags — read as absent.
    const manual = createJob(db, "deep_summary", "Room summary", { steps: [] }, 3);
    expect((getJob(db, manual).plan as Record<string, unknown>).auto).toBeUndefined();
    db.close();
  });
});

describe("artifacts", () => {
  it("artifacts_roundtrip_and_die_with_the_job", () => {
    const db = freshRoom();
    const id = createJob(db, "file_pass", "big.pdf", {}, 3);
    putJobArtifact(db, id, 0, "notes for window 0");
    putJobArtifact(db, id, 1, "notes for window 1");
    // Re-run after a crash overwrites, never duplicates.
    putJobArtifact(db, id, 1, "notes for window 1 (rerun)");
    expect(getJobArtifact(db, id, 1)).toBe("notes for window 1 (rerun)");
    // A step that never ran has nothing stored.
    expect(getJobArtifact(db, id, 2)).toBeNull();
    deleteJob(db, id);
    expect(getJobArtifact(db, id, 0)).toBeNull();
    db.close();
  });

  it("an_artifact_for_a_deleted_job_is_never_written", () => {
    // Delete on a RUNNING workflow removes the row while the job keeps going
    // for one more step. Whatever that step stores must not land as an orphan.
    const db = freshRoom();
    const id = createJob(db, "workflow", "Digest", {}, 2);
    putJobArtifact(db, id, 0, "step 0");
    deleteJob(db, id);

    // The in-flight step's write is accepted (no error surfaces to the runner)
    // but stores nothing.
    putJobArtifact(db, id, 1, "step 1 finished after the delete");
    expect(getJobArtifact(db, id, 1)).toBeNull();
    const left = db.prepare("SELECT count(*) as n FROM job_artifacts").get() as { n: number };
    expect(left.n, "no leftover rows in the room file").toBe(0);
    db.close();
  });
});

describe("children are hidden", () => {
  it("child_jobs_are_hidden_from_lists_and_the_pump", () => {
    const db = freshRoom();
    const parent = createJob(db, "workflow", "Morning digest", {}, 3);
    const child = createChildJob(db, "file_pass", "Full pass — book.pdf", {}, 5, parent);
    setJobStatus(db, parent, "running", null);
    setJobStatus(db, child, "running", null);

    const listed = listJobs(db);
    expect(listed.length).toBe(1);
    expect(listed[0]?.id).toBe(parent);

    const unfinished = unfinishedJobs(db);
    expect(unfinished.length).toBe(1);
    expect(unfinished[0]?.id).toBe(parent);

    // The child is still fetchable directly and carries its parent pointer.
    expect(getJob(db, child).parentJobId).toBe(parent);
    db.close();
  });
});

describe("dedupeParkedJobs", () => {
  it("repair_keeps_one_parked_row_per_unit_of_work", () => {
    const db = freshRoom();
    const wf = (trigger: string, prev: string) => ({
      workflow_id: "wf-1",
      trigger,
      prev_run_at: prev,
    });
    legacyJob(db, "old", "workflow", "Workflow — Digest", wf("schedule", "t1"), "paused", "2026-08-01T09:00:00Z");
    legacyJob(db, "mid", "workflow", "Workflow — Digest", wf("schedule", "t2"), "error", "2026-08-02T09:00:00Z");
    legacyJob(db, "new", "workflow", "Workflow — Digest", wf("manual", "t3"), "paused", "2026-08-03T09:00:00Z");
    // A DIFFERENT workflow, same shape of title — never collapsed together.
    legacyJob(db, "other-wf", "workflow", "Workflow — Weekly", { workflow_id: "wf-2" }, "paused", "2026-08-01T10:00:00Z");
    // Two passes over the same file with DIFFERENT instructions: two real jobs.
    legacyJob(db, "pass-a", "file_pass", "Full pass — book.txt", { instruction: "summarize" }, "paused", "2026-08-01T11:00:00Z");
    legacyJob(db, "pass-b", "file_pass", "Full pass — book.txt", { instruction: "translate" }, "paused", "2026-08-01T12:00:00Z");
    // Same plan twice — nothing tells these apart, so the older one goes.
    legacyJob(db, "index-old", "deep_summary", "Indexing new files", { auto: true }, "paused", "2026-08-01T13:00:00Z");
    legacyJob(db, "index-new", "deep_summary", "Indexing new files", { auto: true }, "error", "2026-08-02T13:00:00Z");
    // Still live, and finished history: both out of scope for the repair.
    legacyJob(db, "running", "workflow", "Workflow — Digest", wf("manual", "t4"), "running", "2026-08-03T10:00:00Z");
    legacyJob(db, "queued", "workflow", "Workflow — Digest", wf("manual", "t5"), "queued", "2026-08-03T11:00:00Z");
    legacyJob(db, "done-1", "workflow", "Workflow — Digest", wf("manual", "t6"), "done", "2026-07-30T09:00:00Z");
    legacyJob(db, "done-2", "workflow", "Workflow — Digest", wf("manual", "t7"), "done", "2026-07-31T09:00:00Z");
    // A parked parent's child rides along when the parent is dropped.
    legacyJob(db, "child-of-old", "file_pass", "Full pass — book.txt", { instruction: "translate" }, "paused", "2026-08-01T09:30:00Z");
    db.prepare("UPDATE jobs SET parent_job_id = 'old' WHERE id = 'child-of-old'").run();

    putJobArtifact(db, "old", 0, "work from the stale attempt");
    putJobArtifact(db, "new", 0, "work from the live attempt");

    expect(dedupeParkedJobs(db), "old + mid workflow attempts, and index-old").toBe(3);
    expect(ids(db)).toEqual([
      "done-1",
      "done-2",
      "index-new",
      "new",
      "other-wf",
      "pass-a",
      "pass-b",
      "queued",
      "running",
    ]);
    // The dropped parent took its child and its artifacts with it.
    expect(getJobArtifact(db, "old", 0)).toBeNull();
    expect(getJobArtifact(db, "new", 0)).toBe("work from the live attempt");
    db.close();
  });

  it("repair_is_a_no_op_on_a_clean_table", () => {
    const db = freshRoom();
    legacyJob(db, "a", "workflow", "Workflow — Digest", { workflow_id: "wf-1" }, "paused", "2026-08-01T09:00:00Z");
    legacyJob(db, "b", "deep_summary", "Room summary", { steps: [1, 2] }, "error", "2026-08-01T10:00:00Z");
    legacyJob(db, "c", "file_pass", "Full pass — book.txt", { instruction: "summarize" }, "paused", "2026-08-01T11:00:00Z");
    const before = ids(db);

    expect(dedupeParkedJobs(db)).toBe(0);
    expect(ids(db)).toEqual(before);
    // Idempotent: repeating the sweep over its own result removes nothing.
    expect(dedupeParkedJobs(db)).toBe(0);
    expect(ids(db)).toEqual(before);
    db.close();
  });

  it("leaves parked rows with unreadable plans untouched", () => {
    const db = freshRoom();
    legacyJob(
      db,
      "broken",
      "file_pass",
      "Full pass — damaged plan",
      { instruction: "summarize" },
      "paused",
      "2026-08-01T09:00:00Z",
    );
    db.prepare("UPDATE jobs SET plan = '{broken' WHERE id = 'broken'").run();

    expect(dedupeParkedJobs(db)).toBe(0);
    expect(ids(db)).toEqual(["broken"]);
    db.close();
  });

  it("failed_auto_index_attempts_collapse_but_named_summaries_do_not", () => {
    const db = freshRoom();
    const auto = (n: number) => ({ auto: true, reduce: false, steps: new Array(n).fill(0) });
    legacyJob(db, "auto-1", "deep_summary", "Indexing new files", auto(3), "error", "2026-08-01T09:00:00Z");
    legacyJob(db, "auto-2", "deep_summary", "Indexing new files", auto(5), "error", "2026-08-02T09:00:00Z");
    legacyJob(db, "auto-3", "deep_summary", "Indexing new files", auto(1), "paused", "2026-08-03T09:00:00Z");
    // A summary the user asked for BY NAME is not the same unit of work.
    const named = (n: number) => ({ auto: false, reduce: true, steps: new Array(n).fill(0) });
    legacyJob(db, "named-a", "deep_summary", "Room summary", named(2), "paused", "2026-08-01T10:00:00Z");
    legacyJob(db, "named-b", "deep_summary", "Room summary", named(4), "error", "2026-08-02T10:00:00Z");

    expect(dedupeParkedJobs(db), "the two stale auto attempts").toBe(2);
    expect(ids(db)).toEqual(["auto-3", "named-a", "named-b"]);
    expect(dedupeParkedJobs(db), "idempotent").toBe(0);

    // And the write path keeps it true.
    const fresh = createJob(db, "deep_summary", "Indexing new files", auto(7), 7);
    expect(ids(db)).toEqual(["named-a", "named-b", fresh].sort());
    db.close();
  });

  it("creating_a_job_retires_only_the_parked_attempt_it_repeats", () => {
    const db = freshRoom();
    legacyJob(db, "parked", "workflow", "Workflow — Digest", { workflow_id: "wf-1", trigger: "schedule" }, "paused", "2026-08-01T09:00:00Z");
    legacyJob(db, "elsewhere", "workflow", "Workflow — Weekly", { workflow_id: "wf-2" }, "paused", "2026-08-01T10:00:00Z");

    const fresh = createJob(db, "workflow", "Workflow — Digest", { workflow_id: "wf-1", trigger: "manual" }, 2);
    expect(ids(db), "only the same workflow's parked row goes").toEqual(["elsewhere", fresh].sort());

    // A child never triggers the guard and is never taken by it.
    const child = createChildJob(db, "file_pass", "Full pass — book.txt", {}, 3, fresh);
    setJobStatus(db, child, "paused", null);
    const sibling = createJob(db, "file_pass", "Full pass — book.txt", {}, 3);
    expect(() => getJob(db, child), "the parent still owns its child").not.toThrow();
    expect(() => getJob(db, sibling)).not.toThrow();
    db.close();
  });

  it("two plans with the same fields in a different order are ONE unit of work", () => {
    // The identity embeds the plan as CANONICAL json (keys sorted), because
    // Rust's `serde_json::Value` is a BTreeMap and its `{plan}` Display is
    // always alphabetical. Plain `JSON.stringify` keeps INSERTION order, which
    // would let two call sites that build the same plan in a different order
    // stack two indistinguishable parked cards for one unit of work — exactly
    // the Activity pile-up this guard exists to stop.
    const db = freshRoom();
    legacyJob(
      db,
      "parked",
      "file_pass",
      "Full pass — book.txt",
      { instruction: "translate", mode: "merge" },
      "paused",
      "2026-08-01T09:00:00Z"
    );
    const fresh = createJob(db, "file_pass", "Full pass — book.txt", { mode: "merge", instruction: "translate" }, 3);
    expect(ids(db)).toEqual([fresh]);
    db.close();
  });
});

describe("parked_reason lifecycle", () => {
  it("the_parking_reason_survives_a_pause_and_nothing_else", () => {
    // 'paused' is where a parked job LANDS, so it must keep the sentence;
    // every other status contradicts it, so keeping it there would leave a job
    // explaining an interruption it is no longer in.
    const db = freshRoom();
    const id = createJob(db, "file_pass", "book.pdf", {}, 3);
    const reason = () => getJob(db, id).parkedReason;

    expect(reason(), "a fresh job has nothing to explain").toBeNull();

    setJobStatus(db, id, "running", null);
    markJobParking(db, id, "the room was locked");
    expect(reason()).toBe("the room was locked");
    setJobStatus(db, id, "paused", null);
    expect(reason()).toBe("the room was locked");

    for (const status of ["queued", "running", "done", "error"]) {
      parkJob(db, id, "the room was locked");
      expect(reason()).toBe("the room was locked");
      setJobStatus(db, id, status, null);
      expect(reason(), `${status} must not keep explaining a park`).toBeNull();
    }

    // A job already parked or finished is not being interrupted by anything —
    // the stamp only reaches rows that still read as live.
    setJobStatus(db, id, "paused", null);
    markJobParking(db, id, "the room was locked");
    expect(reason()).toBeNull();
    setJobStatus(db, id, "done", null);
    markJobParking(db, id, "the room was locked");
    expect(reason()).toBeNull();
    db.close();
  });

  it("setParkedReason stamps a paused row and nothing else", () => {
    // The chained-clip path: a job that paused ITSELF explains why afterwards.
    // Guarded on 'paused' so it can never relabel a live or finished row.
    const db = freshRoom();
    const id = createJob(db, "download", "Clip 2", {}, 1);
    setParkedReason(db, id, "waiting for the previous clip");
    expect(getJob(db, id).parkedReason, "a queued row is not paused").toBeNull();

    setJobStatus(db, id, "paused", null);
    setParkedReason(db, id, "waiting for the previous clip");
    expect(getJob(db, id).parkedReason).toBe("waiting for the previous clip");
    db.close();
  });

  it("park_job_leaves_the_row_resumable_by_every_existing_selector", () => {
    // A parked job is a PAUSED job that explains itself — deliberately not a
    // sixth status, because teaching a new one to `unfinishedJobs`, the queue
    // pump and the duplicate sweep is how a parked run once got treated as
    // in-flight and left a workflow stuck for good.
    const db = freshRoom();
    const plan = { workflow_id: "wf-1" };
    const id = createJob(db, "workflow", "Workflow — Digest", plan, 3);
    setJobStatus(db, id, "running", null);
    checkpointJob(db, id, 1, { done: [0] });
    parkJob(db, id, "the room was locked");

    expect(unfinishedJobs(db).length).toBe(1);
    expect(listJobs(db).length).toBe(1);
    const j = getJob(db, id);
    expect(j.cursor).toBe(1);
    expect((j.state as { done: number[] }).done).toEqual([0]);
    // And it is parked as far as the duplicate sweep is concerned.
    const fresh = createJob(db, "workflow", "Workflow — Digest", plan, 3);
    expect(ids(db)).toEqual([fresh]);
    db.close();
  });

  it("a no-op status write is not an error", () => {
    const db = freshRoom();
    expect(() => setJobStatus(db, "no-such-job", "done", null)).not.toThrow();
    expect(() => parkJob(db, "no-such-job", "whatever")).not.toThrow();
    db.close();
  });
});

describe("workflow run row lifecycle on delete", () => {
  it("deleting_a_workflow_job_closes_its_run_row", () => {
    // Only the runner's epilogue ever closed a run row, so Remove on a
    // workflow left a run reading 'running' with a NULL finished_at forever —
    // a permanent green badge for work that is gone.
    const db = freshRoom();
    legacyWorkflow(db, "wf-1", "Digest");
    const id = createJob(db, "workflow", "Workflow — Digest", { workflow_id: "wf-1" }, 2);
    const runId = createWorkflowRun(db, "wf-1", id, "manual", null);
    deleteJob(db, id);
    const row = db
      .prepare("SELECT status, finished_at FROM workflow_runs WHERE id = ?")
      .get(runId) as { status: string; finished_at: string | null };
    expect(row.status).toBe("paused");
    expect(row.finished_at, "the run row must be closed, not left open").not.toBeNull();
    db.close();
  });

  it("still deletes the job when best-effort workflow cleanup is unavailable", () => {
    const db = freshRoom();
    const id = createJob(db, "file_pass", "Standalone work", {}, 1);
    db.exec("DROP TABLE workflow_runs");

    expect(() => deleteJob(db, id)).not.toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM jobs WHERE id = ?").get(id)).toEqual({ n: 0 });
    db.close();
  });
});

describe("pruneJobHistory", () => {
  it("leaves a finished row with an unreadable plan as independent evidence", () => {
    const db = freshRoom();
    const id = createJob(db, "file_pass", "bad plan", {}, 1);
    setJobStatus(db, id, "done", null);
    db.prepare("UPDATE jobs SET plan = '{broken' WHERE id = ?").run(id);

    expect(pruneJobHistory(db)).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM jobs WHERE id = ?").get(id)).toEqual({ n: 1 });
    db.close();
  });

  it("finished_history_rolls_off_but_live_and_evidenced_rows_stay", () => {
    const db = freshRoom();
    const plan = { file_id: "f1" };
    const JOB_HISTORY_KEEP = 50;
    const done: string[] = [];
    for (let i = 0; i < JOB_HISTORY_KEEP + 3; i++) {
      const id = createJob(db, "file_pass", "big.pdf", plan, 1);
      putJobArtifact(db, id, 0, "notes");
      setJobStatus(db, id, "done", null);
      done.push(id);
    }
    // A stopped row of the same identity — the Retry the user hasn't answered.
    const parked = createJob(db, "file_pass", "big.pdf", plan, 1);
    setJobStatus(db, parked, "error", "OLLAMA_DOWN");
    // A finished workflow job whose run row still names it.
    legacyWorkflow(db, "wf-1", "Digest");
    const wf = createJob(db, "workflow", "Workflow — Digest", { workflow_id: "wf-1" }, 1);
    setJobStatus(db, wf, "done", null);
    const runId = createWorkflowRun(db, "wf-1", wf, "manual", null);
    db.prepare(
      "UPDATE workflow_runs SET status = 'done', finished_at = '2026-08-18T09:00:00Z' WHERE id = ?"
    ).run(runId);

    expect(pruneJobHistory(db)).toBe(3);
    const left = new Set(listJobs(db).map((j) => j.id));
    // The three oldest 'done' rows went, with their artifacts.
    for (const id of done.slice(0, 3)) {
      expect(left.has(id), "an over-the-limit finished row survived").toBe(false);
      expect(getJobArtifact(db, id, 0)).toBeNull();
    }
    expect(left.has(done[3] as string)).toBe(true);
    expect(left.has(parked), "a stopped row is a pending Retry, not history").toBe(true);
    expect(left.has(wf), "a row a run history still names must stay").toBe(true);
    expect(pruneJobHistory(db), "idempotent").toBe(0);
    db.close();
  });

  it("closed_run_rows_roll_off_per_workflow_and_open_ones_never_do", () => {
    const db = freshRoom();
    legacyWorkflow(db, "wf-1", "Digest");
    legacyWorkflow(db, "wf-2", "Weekly");
    const RUN_HISTORY_KEEP = 50;
    for (let i = 0; i < RUN_HISTORY_KEEP + 2; i++) {
      const day = String((i % 28) + 1).padStart(2, "0");
      db.prepare(
        "INSERT INTO workflow_runs(id, workflow_id, status, started_at, finished_at) VALUES (?, 'wf-1', 'done', ?, ?)"
      ).run(`r${i}`, `2026-08-${day}T09:00:00Z`, `2026-08-${day}T09:00:00Z`);
    }
    db.prepare(
      "INSERT INTO workflow_runs(id, workflow_id, status, started_at) VALUES ('live','wf-1','running','2026-01-01T09:00:00Z')"
    ).run();
    // A second workflow with one run keeps it — the limit is per workflow.
    db.prepare(
      "INSERT INTO workflow_runs(id, workflow_id, status, started_at, finished_at) VALUES ('other','wf-2','done','2026-01-01T09:00:00Z','2026-01-01T09:00:00Z')"
    ).run();

    pruneJobHistory(db);
    const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    expect(
      count("SELECT count(*) as n FROM workflow_runs WHERE workflow_id = 'wf-1'"),
      "the open run is never swept"
    ).toBe(RUN_HISTORY_KEEP + 1);
    expect(count("SELECT count(*) as n FROM workflow_runs WHERE id = 'live'")).toBe(1);
    expect(count("SELECT count(*) as n FROM workflow_runs WHERE id = 'other'")).toBe(1);
    db.close();
  });
});

describe("error status", () => {
  it("maps malformed persisted JSON fields to null instead of failing the Activity list", () => {
    const db = freshRoom();
    const id = createJob(db, "deep_summary", "legacy row", {}, 1);
    db.prepare("UPDATE jobs SET plan = '{bad', state = '{also-bad' WHERE id = ?").run(id);

    expect(getJob(db, id)).toMatchObject({ id, plan: null, state: null });
    db.close();
  });

  it("error_status_carries_a_message", () => {
    const db = freshRoom();
    const id = createJob(db, "deep_summary", "x", {}, 1);
    setJobStatus(db, id, "error", "OLLAMA_DOWN");
    const j = getJob(db, id);
    expect(j.status).toBe("error");
    expect(j.error).toBe("OLLAMA_DOWN");
    db.close();
  });
});
