/**
 * Tests for `workflowRuns.ts` — the batch that wires `workflowModel.ts` /
 * `workflowEngine.ts` / `workflowCompose.ts` into the REAL job queue. Driven
 * against real fixture rooms (a real `createRoom` SQLite DB) and the real,
 * already-committed queue machinery (`jobs.ts`'s `runPlan`/`spawnJobRunner`,
 * `jobQueue.ts`'s `submit`/`pump`) — never a hand-rolled fake of either. Only
 * the leaves this migration has not ported anywhere (sidecar HTTP, external
 * CLIs) are stubbed, exactly as `workflowEngine.test.ts` already does.
 *
 * Every Rust unit test this slice owns is ported BY NAME from
 * `src-tauri/src/commands/jobs/workflow.rs`'s `#[cfg(test)] mod tests`:
 *   - a_script_waiting_for_approval_parks_the_run_instead_of_failing_it
 *   - a_paused_run_neither_blocks_the_next_one_nor_reads_as_running
 *   - parked_runs_do_not_pile_up_one_per_trigger
 *   - retiring_stale_attempts_does_not_erase_the_runs_that_finished
 *   - the_new_files_window_only_moves_on_a_run_that_finished
 *   - workflow_runs_to_completion_and_skips_the_dead_branch_transitively —
 *     driven here through the REAL queue (`startWorkflowRun` → `submit` →
 *     `workflowRowStarter` → `spawnWorkflowJob`), not `drive_workflow`'s
 *     bypass, which `workflowEngine.test.ts` already covers; this file's job is
 *     proving the run actually reaches it.
 *
 * PLUS coverage the Rust module could not exercise without a full Tauri
 * `AppState`/`Window`: both wire adapters, the refusal order in
 * `startWorkflowRun`, `run_workflow`'s script-consent seam, the command gates,
 * and all six agent tools.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";

import { CancelFlag, createCancelState, type CancelState } from "./cancel.js";
import { createRoom } from "./db-host/open.js";
import { getFileExtractedText, getFileMeta, insertFile } from "./db-host/files.js";
import {
  createJob,
  getJob,
  getJobArtifact,
  listJobs,
  putJobArtifact,
  setJobStatus,
} from "./db-host/jobs.js";
import {
  createWorkflow,
  createWorkflowRun,
  finishWorkflowRunByJob,
  getSchedule,
  getWorkflow,
  listWorkflowRuns,
  setWorkflowRunStatusByJob,
} from "./db-host/workflows.js";
import {
  createJobQueueState,
  pump,
  QUEUE_FULL,
  UNREADABLE_PLAN,
  type JobQueueDeps,
  type RowStarter,
} from "./jobQueue.js";
import {
  compileWorkflow,
  defaultResolvedModel,
  type WorkflowDef,
  type WorkflowPlan,
} from "./workflowModel.js";
import type { JobProgressPayload, ProgressSink, RoomHandle, RoomSource } from "./jobs.js";
import { ROLLBACK_BUSY } from "./turnContext.js";
import { addScriptApproval } from "./scriptConsent.js";
import { resetBinCachesForTests, scriptFingerprint, setCachedPathPrefix } from "./scriptRun.js";
import {
  agentDeleteWorkflow,
  agentListWorkflows,
  agentRunWorkflow,
  agentSaveWorkflow,
  agentTestWorkflow,
  agentUpdateWorkflow,
  ALREADY_RUNNING_OR_QUEUED,
  DEFINITION_UNREADABLE,
  deleteWorkflowCmd,
  emitWorkflowsChanged,
  hasInflightRun,
  parkOutcome,
  planToWire,
  previousRunAt,
  retireParkedJobs,
  ROOM_CHANGED_STARTING,
  RUN_INPUT_NEEDS_FILE,
  runWorkflowCommand,
  SCRIPT_APPROVAL_UI_NOT_IMPLEMENTED,
  setWorkflowPinnedCmd,
  setWorkflowScheduleCmd,
  setWorkflowStatusCmd,
  spawnWorkflowJob,
  startWorkflowRun,
  wireToPlan,
  WORKFLOW_NODE_REFERENCE,
  WORKFLOW_PLAN_UNREADABLE,
  workflowQueueDeps,
  workflowRowStarter,
  type AgentTestWorkflowDeps,
  type RunWorkflowCommandDeps,
  type SpawnWorkflowJobDeps,
  type WorkflowRunDeps,
} from "./workflowRuns.js";

// ============================================================================
// fixtures
// ============================================================================

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  setCachedPathPrefix("");
  resetBinCachesForTests();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function freshRoom(roomPath = "mem://workflow-runs"): { db: Database.Database; path: string } {
  const file = path.join(tempDir("workflow-runs-"), `pr-test-${randomUUID()}.roomai`);
  const db = createRoom(file, "correct horse battery staple", "Test Room");
  return { db, path: roomPath };
}

class OneRoom implements RoomSource {
  constructor(private room: RoomHandle | null) {}
  current(): RoomHandle | null {
    return this.room;
  }
  swapTo(room: RoomHandle | null): void {
    this.room = room;
  }
}

function fakeSink(): { sink: ProgressSink; events: JobProgressPayload[] } {
  const events: JobProgressPayload[] = [];
  return { sink: { emit: (p) => events.push(p) }, events };
}

/** Poll until `check()` is true — the fire-and-forget runner does real async
 * work (`Promise.all` over a plan wave), so a fixed number of ticks is not a
 * guarantee. Same shape as `jobDownload.test.ts`'s own `waitUntil`. */
async function waitUntil(check: () => boolean, timeoutMs = 10_000, stepMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function settled(db: Database.Database, jobId: string): boolean {
  const status = getJob(db, jobId).status;
  return status !== "queued" && status !== "running";
}

/** The Rust suite's own `branching_def`: transform → condition → {hot | cold →
 * cold2} → merge → save_file. No model call, no network, fully deterministic. */
function branchingDef(): WorkflowDef {
  return {
    version: 1,
    nodes: [
      { id: "seed", label: "", kind: "transform", op: "append", find: null, value: "alpha" },
      { id: "gate", label: "", kind: "condition", op: "contains", value: "alpha" },
      { id: "hot", label: "", kind: "transform", op: "append", find: null, value: " HOT" },
      { id: "cold", label: "", kind: "transform", op: "append", find: null, value: " COLD" },
      { id: "cold2", label: "", kind: "transform", op: "append", find: null, value: " COLD2" },
      { id: "join", label: "", kind: "merge", mode: "concat", separator: "||" },
      { id: "out", label: "", kind: "save_file", name_template: "wf-out", format: "md", mode: "create" },
    ] as WorkflowDef["nodes"],
    edges: [
      { from: "seed", to: "gate", branch: null },
      { from: "gate", to: "hot", branch: "then" },
      { from: "gate", to: "cold", branch: "else" },
      { from: "cold", to: "cold2", branch: null },
      { from: "hot", to: "join", branch: null },
      { from: "cold2", to: "join", branch: null },
      { from: "join", to: "out", branch: null },
    ],
  };
}

/** The simplest RUNNABLE definition — one deterministic transform. */
function upperTransformDef(): WorkflowDef {
  return {
    version: 1,
    nodes: [
      { id: "up", label: "Shout it", kind: "transform", op: "upper", find: null, value: null },
    ] as WorkflowDef["nodes"],
    edges: [],
  };
}

/** Two transforms in series — two waves, so a checkpoint/Stop is observable. */
function twoStepDef(): WorkflowDef {
  return {
    version: 1,
    nodes: [
      { id: "a", label: "a", kind: "transform", op: "upper", find: null, value: null },
      { id: "b", label: "b", kind: "transform", op: "lower", find: null, value: null },
    ] as WorkflowDef["nodes"],
    edges: [{ from: "a", to: "b", branch: null }],
  };
}

/** A single `agent_run` node — the deliberately-failing shape: with no
 * `agentRun` dep supplied, `workflowEngine.ts`'s default
 * `agentRunNotImplemented` rejects it, so the job must land 'error'. */
function agentOnlyDef(): WorkflowDef {
  return {
    version: 1,
    nodes: [
      { id: "ask", label: "", kind: "agent_run", question: "what is the weather" },
    ] as WorkflowDef["nodes"],
    edges: [],
  };
}

function scriptDef(fileId: string): WorkflowDef {
  return {
    version: 1,
    nodes: [
      { id: "s", label: "s", kind: "script_run", file: fileId, mode: "transform" },
    ] as WorkflowDef["nodes"],
    edges: [],
  };
}

function runInputDef(): WorkflowDef {
  return {
    version: 1,
    nodes: [
      { id: "s", label: "", kind: "summarize_file", select: { type: "run_input" } },
    ] as WorkflowDef["nodes"],
    edges: [],
  };
}

/** A definition that PARSES cleanly (every node kind recognized) but FAILS
 * `validate_with_binding` — a dangling edge target. Distinct from an unknown
 * `kind`, which fails at the strict-parse stage and never reaches numbered-list
 * validation at all. */
function danglingEdgeDef(): WorkflowDef {
  return {
    version: 1,
    nodes: [
      { id: "a", label: "", kind: "transform", op: "upper", find: null, value: null },
    ] as WorkflowDef["nodes"],
    edges: [{ from: "a", to: "missing", branch: null }],
  };
}

const FILE_BINDING = { scope: "file", kinds: [], exts: [], file_id: null };

function baseRunDeps(overrides: Partial<WorkflowRunDeps> = {}): {
  deps: WorkflowRunDeps;
  rooms: OneRoom;
  db: Database.Database;
  roomPath: string;
  events: JobProgressPayload[];
  cancelState: CancelState;
} {
  const { db, path: roomPath } = freshRoom();
  const rooms = new OneRoom({ db, path: roomPath });
  const { sink, events } = fakeSink();
  const cancelState = createCancelState();
  const deps: WorkflowRunDeps = {
    state: createJobQueueState(),
    rooms,
    sink,
    cancelState,
    starters: new Map<string, RowStarter>(),
    cacheDir: tempDir("workflow-runs-cache-"),
    userDataDir: tempDir("workflow-runs-userdata-"),
    listModels: async () => [],
    ...overrides,
  };
  return { deps, rooms, db, roomPath, events, cancelState };
}

function makeRunnerDeps(
  db: Database.Database,
  roomPath = "room-a"
): {
  deps: SpawnWorkflowJobDeps;
  events: JobProgressPayload[];
  removed: string[];
  settledJobs: string[];
  emitted: Array<[string, unknown]>;
} {
  const { sink, events } = fakeSink();
  const removed: string[] = [];
  const settledJobs: string[] = [];
  const emitted: Array<[string, unknown]> = [];
  return {
    deps: {
      rooms: new OneRoom({ db, path: roomPath }),
      sink,
      removeCancelFlag: (jobId: string) => removed.push(jobId),
      onSettled: (jobId: string) => {
        settledJobs.push(jobId);
      },
      cacheDir: tempDir("workflow-runs-cache-"),
      emit: (event, payload) => emitted.push([event, payload]),
    },
    events,
    removed,
    settledJobs,
    emitted,
  };
}

/** Mint a real job + run row for a def, plus the in-memory plan a runner takes
 * — the direct-`spawnWorkflowJob` fixture (no queue involved). */
function planFor(
  db: Database.Database,
  def: WorkflowDef,
  trigger = "manual"
): { wfId: string; jobId: string; plan: WorkflowPlan } {
  const wfId = createWorkflow(db, "W", "", "", def, "user", { scope: "general" });
  const compiled = compileWorkflow(def, null, []);
  if (!compiled.ok) {
    throw new Error(`fixture def failed to compile: ${compiled.errors.join(" ")}`);
  }
  const jobId = createJob(db, "workflow", "Workflow — W", { workflow_id: wfId }, compiled.steps.length);
  createWorkflowRun(db, wfId, jobId, trigger, null);
  return {
    wfId,
    jobId,
    plan: {
      workflow_id: wfId,
      workflow_name: "W",
      trigger,
      def,
      resolved_model: defaultResolvedModel(null, []),
      input_file_id: null,
      prev_run_at: null,
      script_consents: new Map<string, string>(),
      steps: compiled.steps,
    },
  };
}

// ============================================================================
// park_outcome
// ============================================================================

describe("parkOutcome", () => {
  it("a_script_waiting_for_approval_parks_the_run_instead_of_failing_it", () => {
    // An unapproved `script_run` step returned an ordinary error, so the run
    // landed as 'error': the user saw a failed workflow and the model was told
    // to "fix the failing step" — of a script nobody had approved yet. It is a
    // PAUSE, and it is the only pause with a reason to give.
    const park = "NEEDS_APPROVAL: This workflow runs a script that isn't approved on this Mac yet.";
    expect(parkOutcome({ kind: "error", error: park }, false)).toEqual([
      { kind: "paused" },
      "This workflow runs a script that isn't approved on this Mac yet.",
    ]);

    // A user-pressed Stop is also a pause — with NOTHING to say about approvals.
    expect(parkOutcome({ kind: "error", error: "read timed out" }, true)).toEqual([
      { kind: "paused" },
      null,
    ]);

    // A genuinely failing step is still a failure, and still says why.
    expect(parkOutcome({ kind: "error", error: "the model returned nothing" }, false)).toEqual([
      { kind: "error", error: "the model returned nothing" },
      null,
    ]);

    expect(parkOutcome({ kind: "done" }, false)).toEqual([{ kind: "done" }, null]);
  });

  it("done and paused pass through unchanged, and a Stop wins over the marker", () => {
    expect(parkOutcome({ kind: "paused" }, true)).toEqual([{ kind: "paused" }, null]);
    // Stopped is checked FIRST: a Stop during a parked script must not borrow
    // the approval sentence.
    expect(parkOutcome({ kind: "error", error: "NEEDS_APPROVAL: nope" }, true)).toEqual([
      { kind: "paused" },
      null,
    ]);
  });
});

// ============================================================================
// The wire adapters
// ============================================================================

describe("planToWire / wireToPlan", () => {
  function samplePlan(): WorkflowPlan {
    const def = upperTransformDef();
    const compiled = compileWorkflow(def, null, []);
    if (!compiled.ok) throw new Error("fixture failed to compile");
    return {
      workflow_id: "wf-1",
      workflow_name: "Test",
      trigger: "manual",
      def,
      resolved_model: "m",
      input_file_id: null,
      prev_run_at: null,
      script_consents: new Map([["file-1", "sha-1"]]),
      steps: compiled.steps,
    };
  }

  it("writes Rust's own depends_on, never this port's runtime dependsOn", () => {
    const wire = planToWire(samplePlan()) as Record<string, unknown>;
    const steps = wire["steps"] as Array<Record<string, unknown>>;
    expect(steps[0]).toHaveProperty("depends_on");
    expect(steps[0]).not.toHaveProperty("dependsOn");
    expect(steps[0]?.["depends_on"]).toEqual([]);
  });

  it("round-trips a plan, and reads a legacy dependsOn row too", () => {
    const wire = planToWire(samplePlan()) as Record<string, unknown>;
    const back = wireToPlan(wire);
    expect(back.workflow_id).toBe("wf-1");
    expect(back.steps[0]?.dependsOn).toEqual([]);
    expect(back.script_consents).toBeInstanceOf(Map);
    expect(back.script_consents.get("file-1")).toBe("sha-1");

    // A row written by an EARLIER build of this port spelled it camelCase; a
    // real queued job must still resume rather than be poisoned over a name.
    const legacy = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
    const legacySteps = legacy["steps"] as Array<Record<string, unknown>>;
    legacySteps[0]!["dependsOn"] = [3];
    delete legacySteps[0]!["depends_on"];
    expect(wireToPlan(legacy).steps[0]?.dependsOn).toEqual([3]);
  });

  it("script_consents crosses the wire as a plain object, not a Map", () => {
    const wire = planToWire(samplePlan()) as Record<string, unknown>;
    const consents = wire["script_consents"];
    expect(consents).not.toBeInstanceOf(Map);
    expect(Object.getPrototypeOf(consents)).toBeNull();
    expect((consents as Record<string, string>)["file-1"]).toBe("sha-1");
  });

  it("a __proto__-named consent key round-trips as an ordinary entry, never as prototype pollution", () => {
    const plan = samplePlan();
    plan.script_consents = new Map([["__proto__", "sha-evil"]]);
    const wire = planToWire(plan);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();

    // JSON.parse — the REAL read path (`job.plan` comes back through it) —
    // defines `__proto__` as an ordinary OWN data property, which is the shape
    // the own-key-only read must survive. An object LITERAL would set the
    // prototype instead and prove nothing.
    const stored = JSON.parse(JSON.stringify(wire)) as unknown;
    const back = wireToPlan(stored);
    expect(back.script_consents.get("__proto__")).toBe("sha-evil");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("throws the WORKFLOW-specific unreadable sentence on any structural failure", () => {
    expect(WORKFLOW_PLAN_UNREADABLE).toBe("This workflow's plan is unreadable.");
    // Not jobQueue.ts's generic one — only `start_workflow_row` spells it this
    // way, and a port that shared the generic sentence would quietly change
    // what the Sidebar says about a broken workflow row.
    expect(WORKFLOW_PLAN_UNREADABLE).not.toBe(UNREADABLE_PLAN);
    expect(() => wireToPlan(null)).toThrow(WORKFLOW_PLAN_UNREADABLE);
    expect(() => wireToPlan("a string")).toThrow(WORKFLOW_PLAN_UNREADABLE);
    expect(() => wireToPlan({ not: "a plan" })).toThrow(WORKFLOW_PLAN_UNREADABLE);
  });

  it("refuses a step whose depends_on or lane is malformed", () => {
    const wire = planToWire(samplePlan()) as Record<string, unknown>;
    const broken = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
    (broken["steps"] as Array<Record<string, unknown>>)[0]!["depends_on"] = "not-an-array";
    expect(() => wireToPlan(broken)).toThrow(WORKFLOW_PLAN_UNREADABLE);

    const badLane = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
    (badLane["steps"] as Array<Record<string, unknown>>)[0]!["lane"] = "gpu";
    expect(() => wireToPlan(badLane)).toThrow(WORKFLOW_PLAN_UNREADABLE);
  });
});

// ============================================================================
// previous_run_at / has_inflight_run / retire_parked_jobs
// ============================================================================

describe("previousRunAt", () => {
  it("the_new_files_window_only_moves_on_a_run_that_finished", () => {
    const { db } = freshRoom();
    const wf = createWorkflow(db, "Digest", "", "", {}, "user", { scope: "general" });
    expect(previousRunAt(db, wf)).toBeNull();

    const ok = createJob(db, "workflow", "w", {}, 1);
    createWorkflowRun(db, wf, ok, "schedule", null);
    finishWorkflowRunByJob(db, ok, "done", null);
    const afterSuccess = previousRunAt(db, wf);
    expect(afterSuccess).not.toBeNull();

    // A LATER run that failed must not move the window past it.
    const bad = createJob(db, "workflow", "w", {}, 1);
    createWorkflowRun(db, wf, bad, "schedule", null);
    finishWorkflowRunByJob(db, bad, "error", "the model was down");
    expect(previousRunAt(db, wf)).toBe(afterSuccess);

    // Nor a parked one.
    const stopped = createJob(db, "workflow", "w", {}, 1);
    createWorkflowRun(db, wf, stopped, "manual", null);
    setWorkflowRunStatusByJob(db, stopped, "paused");
    expect(previousRunAt(db, wf)).toBe(afterSuccess);
  });

  it("still finds the last success past the 50-row listWorkflowRuns cap", () => {
    // `listWorkflowRuns` is capped at 50 rows (here and in Rust). Deriving this
    // from that list instead of its own query silently loses the window for any
    // busy workflow — every since_last_run node would then reprocess the whole
    // room, forever.
    const { db } = freshRoom();
    const wf = createWorkflow(db, "Busy", "", "", {}, "user", { scope: "general" });
    const first = createJob(db, "workflow", "w", {}, 1);
    createWorkflowRun(db, wf, first, "schedule", null);
    finishWorkflowRunByJob(db, first, "done", null);
    // `started_at` has second granularity, so age the successful run explicitly
    // — otherwise 61 rows minted in the same second tie and the 50-row window
    // keeps it by accident, proving nothing.
    db.prepare("UPDATE workflow_runs SET started_at = ? WHERE job_id = ?").run(
      "2020-01-01T00:00:00Z",
      first
    );

    for (let i = 0; i < 60; i++) {
      const job = createJob(db, "workflow", "w", {}, 1);
      createWorkflowRun(db, wf, job, "schedule", null);
      finishWorkflowRunByJob(db, job, "error", "nope");
    }
    expect(listWorkflowRuns(db, wf)).toHaveLength(50);
    expect(listWorkflowRuns(db, wf).some((r) => r.status === "done")).toBe(false);
    expect(previousRunAt(db, wf)).toBe("2020-01-01T00:00:00Z");
  });
});

describe("hasInflightRun", () => {
  it("a_paused_run_neither_blocks_the_next_one_nor_reads_as_running", () => {
    const { db } = freshRoom();
    const wf = createWorkflow(db, "Digest", "", "", {}, "user", { scope: "general" });
    const job = createJob(db, "workflow", "Workflow — Digest", {}, 3);
    createWorkflowRun(db, wf, job, "manual", null);

    setJobStatus(db, job, "running", null);
    expect(hasInflightRun(db, wf)).toBe(true);
    setJobStatus(db, job, "queued", null);
    expect(hasInflightRun(db, wf)).toBe(true);

    // Parked: resumable from Activity, but not in flight.
    setJobStatus(db, job, "paused", null);
    setWorkflowRunStatusByJob(db, job, "paused");
    expect(hasInflightRun(db, wf)).toBe(false);
    const runs = listWorkflowRuns(db, wf);
    expect(runs[0]?.status).toBe("paused");
    expect(runs[0]?.finishedAt).toBeNull();
  });
});

describe("retireParkedJobs", () => {
  it("parked_runs_do_not_pile_up_one_per_trigger", () => {
    const { db } = freshRoom();
    const wf = createWorkflow(db, "Digest", "", "", {}, "user", { scope: "general" });
    const liveJobs = (): number =>
      listWorkflowRuns(db, wf).filter((r) => {
        if (r.jobId === null) return false;
        try {
          getJob(db, r.jobId);
          return true;
        } catch {
          return false;
        }
      }).length;

    for (let i = 0; i < 3; i++) {
      const job = createJob(db, "workflow", "Workflow — Digest", {}, 3);
      createWorkflowRun(db, wf, job, "schedule", null);
      setJobStatus(db, job, "paused", null);
      setWorkflowRunStatusByJob(db, job, "paused");
      retireParkedJobs(db, wf);
    }
    expect(liveJobs()).toBe(0);
    // The HISTORY survives — only the resumable job is dropped.
    expect(listWorkflowRuns(db, wf)).toHaveLength(3);

    const live = createJob(db, "workflow", "Workflow — Digest", {}, 3);
    createWorkflowRun(db, wf, live, "manual", null);
    setJobStatus(db, live, "running", null);
    retireParkedJobs(db, wf);
    expect(() => getJob(db, live)).not.toThrow();
  });

  it("retiring_stale_attempts_does_not_erase_the_runs_that_finished", () => {
    const { db } = freshRoom();
    const wf = createWorkflow(db, "Digest", "", "", {}, "user", { scope: "general" });
    const finished: string[] = [];
    for (let i = 0; i < 3; i++) {
      const job = createJob(db, "workflow", "Workflow — Digest", {}, 3);
      createWorkflowRun(db, wf, job, "schedule", null);
      setJobStatus(db, job, "done", null);
      finished.push(job);
    }
    const stale = createJob(db, "workflow", "Workflow — Digest", {}, 3);
    createWorkflowRun(db, wf, stale, "schedule", null);
    setJobStatus(db, stale, "paused", null);

    retireParkedJobs(db, wf);

    expect(() => getJob(db, stale)).toThrow();
    for (const job of finished) {
      expect(() => getJob(db, job)).not.toThrow();
    }
  });
});

// ============================================================================
// spawn_workflow_job — the runner, driven directly
// ============================================================================

describe("spawnWorkflowJob", () => {
  it("runs a real plan through jobs.ts's real runPlan to completion", async () => {
    const { db } = freshRoom();
    const { deps, events, removed, settledJobs, emitted } = makeRunnerDeps(db);
    const { jobId, plan } = planFor(db, upperTransformDef());

    await spawnWorkflowJob(deps, jobId, "room-a", plan, new Set(), new CancelFlag());

    const row = getJob(db, jobId);
    expect(row.status).toBe("done");
    expect(row.error).toBeNull();
    expect(removed).toEqual([jobId]);
    expect(settledJobs).toEqual([jobId]);
    // The engine's own per-node `workflow-node` events share this emitter; the
    // LAST thing a terminal run says is the workflow-list broadcast.
    expect(emitted[emitted.length - 1]).toEqual(["workflows-changed", undefined]);
    expect(emitted.filter(([e]) => e === "workflows-changed")).toHaveLength(1);

    const runs = listWorkflowRuns(db, plan.workflow_id);
    expect(runs[0]?.status).toBe("done");
    expect(runs[0]?.finishedAt).not.toBeNull();

    const last = events[events.length - 1];
    expect(last?.finished).toBe(true);
    expect(last?.label).toBe("Workflow “W” finished");
  });

  it("a manual run publishes save_file's file as the terminal fileId; a scheduled run does not", async () => {
    const def: WorkflowDef = {
      version: 1,
      nodes: [
        { id: "gen", label: "gen", kind: "transform", op: "upper", find: null, value: null },
        { id: "save", label: "save", kind: "save_file", name_template: "Output", format: "html", mode: "create" },
      ] as WorkflowDef["nodes"],
      edges: [{ from: "gen", to: "save", branch: null }],
    };

    const manual = freshRoom();
    const manualDeps = makeRunnerDeps(manual.db, "room-manual");
    const manualPlan = planFor(manual.db, def, "manual");
    await spawnWorkflowJob(
      manualDeps.deps,
      manualPlan.jobId,
      "room-manual",
      manualPlan.plan,
      new Set(),
      new CancelFlag()
    );
    expect(getJob(manual.db, manualPlan.jobId).status).toBe("done");
    const manualFinished = manualDeps.events.find((e) => e.finished === true);
    expect(manualFinished?.fileId).toBeTruthy();

    const sched = freshRoom();
    const schedDeps = makeRunnerDeps(sched.db, "room-sched");
    const schedPlan = planFor(sched.db, def, "schedule");
    await spawnWorkflowJob(
      schedDeps.deps,
      schedPlan.jobId,
      "room-sched",
      schedPlan.plan,
      new Set(),
      new CancelFlag()
    );
    const schedFinished = schedDeps.events.find((e) => e.finished === true);
    expect(schedFinished?.fileId ?? null).toBeNull();
  });

  it("Stop mid-run parks the job as 'paused' with no reason, and the run row is not closed", async () => {
    const { db } = freshRoom();
    const { deps, events } = makeRunnerDeps(db);
    const { jobId, plan } = planFor(db, twoStepDef());

    const cancel = new CancelFlag();
    cancel.store(true); // already stopped before the run even starts
    await spawnWorkflowJob(deps, jobId, "room-a", plan, new Set(), cancel);

    const row = getJob(db, jobId);
    expect(row.status).toBe("paused");
    expect(row.parkedReason).toBeNull();
    const runs = listWorkflowRuns(db, plan.workflow_id);
    expect(runs[0]?.status).toBe("paused");
    expect(runs[0]?.finishedAt).toBeNull(); // a pause is NOT terminal
    expect(events[events.length - 1]?.paused).toBe(true);
  });

  it("an unapproved script_run node parks with the script's own sentence as the reason", async () => {
    const { db } = freshRoom();
    const script = insertFile(db, "hello.py", "text/x-python", Buffer.from("print('hi')\n"), "print('hi')\n", "upload");
    const { deps, events } = makeRunnerDeps(db);
    const { jobId, plan } = planFor(db, scriptDef(script.id)); // script_consents stays empty

    await spawnWorkflowJob(deps, jobId, "room-a", plan, new Set(), new CancelFlag());

    const row = getJob(db, jobId);
    expect(row.status).toBe("paused");
    expect(row.parkedReason).toContain("isn't approved on this Mac yet");
    expect(row.error).toBeNull(); // a park is NOT a failure
    expect(listWorkflowRuns(db, plan.workflow_id)[0]?.status).toBe("paused");
    // The terminal card says the reason in its own words, not a fixed sentence.
    expect(events[events.length - 1]?.label).toContain("isn't approved on this Mac yet");
  });

  it("checkpoints the whole done SET, so a resume seeds from it and not a cursor", async () => {
    const { db } = freshRoom();
    const { deps } = makeRunnerDeps(db);
    const { jobId, plan } = planFor(db, twoStepDef());
    await spawnWorkflowJob(deps, jobId, "room-a", plan, new Set(), new CancelFlag());
    const row = getJob(db, jobId);
    expect(row.cursor).toBe(2);
    expect(row.state).toEqual({ done: [0, 1] });
  });

  it("a room that is no longer the job's own still reaches a terminal event and frees the slot", async () => {
    // Every DB write in Rust's epilogue is `let _ = …`: a room that swapped (so
    // `pinnedDb` answers null for every read AND every write) must still cost
    // the queue nothing. Without that, the slot would stay reserved for the
    // rest of the session and every later job would wedge behind it.
    const { db } = freshRoom();
    const { deps, events, removed, settledJobs } = makeRunnerDeps(db);
    const { jobId, plan } = planFor(db, upperTransformDef());
    await spawnWorkflowJob(deps, jobId, "a-room-that-is-not-open", plan, new Set(), new CancelFlag());
    expect(removed).toEqual([jobId]);
    expect(settledJobs).toEqual([jobId]);
    const last = events[events.length - 1];
    expect(last?.jobId).toBe(jobId);
    expect(last?.finished === true || last?.failed === true || last?.paused === true).toBe(true);
  });
});

// ============================================================================
// workflowRowStarter
// ============================================================================

describe("workflowRowStarter", () => {
  it("refuses a job whose plan is unreadable with the workflow-specific sentence", async () => {
    const { db, path: roomPath } = freshRoom();
    const jobId = createJob(db, "workflow", "Workflow — bad plan", "not an object", 0);
    const rooms = new OneRoom({ db, path: roomPath });
    const { sink } = fakeSink();
    const deps: JobQueueDeps = {
      state: createJobQueueState(),
      rooms,
      sink,
      cancelState: createCancelState(),
      starters: new Map(),
    };
    const starter = workflowRowStarter({ cacheDir: tempDir("wf-row-") });
    const result = await starter(deps, getJob(db, jobId), roomPath, new CancelFlag());
    expect(result).toEqual({ kind: "error", message: WORKFLOW_PLAN_UNREADABLE });
  });
});

// ============================================================================
// start_workflow_run — end to end through the REAL job queue
// ============================================================================

describe("startWorkflowRun — end to end through the real job queue", () => {
  it("workflow_runs_to_completion_and_skips_the_dead_branch_transitively", async () => {
    const { deps, db, events } = baseRunDeps();
    const workflowId = createWorkflow(db, "Branching digest", "", "", branchingDef(), "user", {
      scope: "general",
    });

    const jobId = await startWorkflowRun(deps, workflowId, "manual", null, new Set());
    expect(jobId).not.toBe("");
    await waitUntil(() => settled(db, jobId));

    const job = getJob(db, jobId);
    expect(job.status).toBe("done");
    // The job row ends fully checkpointed: cursor == total and the state blob
    // names every step.
    expect(job.cursor).toBe(7);
    expect(job.state).toEqual({ done: [0, 1, 2, 3, 4, 5, 6] });

    const runs = listWorkflowRuns(db, workflowId);
    expect(runs[0]?.status).toBe("done");
    expect(runs[0]?.finishedAt).not.toBeNull();

    const finished = events.find((e) => e.finished === true);
    expect(finished?.done).toBe(7);
    expect(finished?.total).toBe(7);
    expect(finished?.fileId).toBeTruthy();

    // save_file wrote the merged text into the room — and the merge saw ONLY
    // the live branch (no empty slot, no separator), which is what proves the
    // dead arm and its transitive child were skipped rather than run empty.
    const fileId = finished?.fileId as string;
    const meta = getFileMeta(db, fileId);
    expect(meta.name).toBe("wf-out.md");
    expect(meta.source).toBe("generated");
    expect(getFileExtractedText(db, fileId)).toBe("branch: then HOT");
  });

  it("persists the plan in Rust's own wire shape", async () => {
    const { deps, db } = baseRunDeps();
    const workflowId = createWorkflow(db, "Shout", "", "", upperTransformDef(), "user", {
      scope: "general",
    });
    const jobId = await startWorkflowRun(deps, workflowId, "manual", null, new Set());
    await waitUntil(() => settled(db, jobId));
    const stored = getJob(db, jobId).plan as { steps: Array<Record<string, unknown>> };
    expect(stored.steps[0]).toHaveProperty("depends_on");
    expect(stored.steps[0]).not.toHaveProperty("dependsOn");
  });

  it("a scheduled run never carries a fileId in its terminal payload (must not yank the viewer)", async () => {
    const { deps, db, events } = baseRunDeps();
    const workflowId = createWorkflow(db, "Branching digest", "", "", branchingDef(), "user", {
      scope: "general",
    });
    const jobId = await startWorkflowRun(deps, workflowId, "schedule", null, new Set());
    await waitUntil(() => settled(db, jobId));
    expect(events.find((e) => e.finished === true)?.fileId ?? null).toBeNull();
  });

  it("a deliberately-failing node (agent_run with no agentRun dep) surfaces as a real failure through the whole chain", async () => {
    const { deps, db, events } = baseRunDeps();
    const workflowId = createWorkflow(db, "Ask agent", "", "", agentOnlyDef(), "user", {
      scope: "general",
    });
    const jobId = await startWorkflowRun(deps, workflowId, "manual", null, new Set());
    await waitUntil(() => settled(db, jobId));

    const job = getJob(db, jobId);
    expect(job.status).toBe("error");
    expect(job.error).toMatch(/NOT_IMPLEMENTED/);
    expect(listWorkflowRuns(db, workflowId)[0]?.status).toBe("error");
    expect(events.find((e) => e.failed === true)?.label).toMatch(/^Stopped — /);
  });

  it("refuses a run_input def with no file", async () => {
    const { deps, db } = baseRunDeps();
    const workflowId = createWorkflow(db, "File-bound", "", "", runInputDef(), "user", FILE_BINDING);
    await expect(startWorkflowRun(deps, workflowId, "manual", null, new Set())).rejects.toThrow(
      RUN_INPUT_NEEDS_FILE
    );
  });

  it("an unreadable definition throws the fixed sentence, not parse_def's numbered list", async () => {
    const { deps, db } = baseRunDeps();
    const workflowId = createWorkflow(db, "Broken", "", "", { not: "a workflow def" }, "user", {
      scope: "general",
    });
    await expect(startWorkflowRun(deps, workflowId, "manual", null, new Set())).rejects.toThrow(
      DEFINITION_UNREADABLE
    );
  });

  it("refuses (before minting anything) a definition that cannot compile", async () => {
    const { deps, db } = baseRunDeps();
    const workflowId = createWorkflow(db, "Empty", "", "", { version: 1, nodes: [], edges: [] }, "user", {
      scope: "general",
    });
    await expect(startWorkflowRun(deps, workflowId, "manual", null, new Set())).rejects.toThrow();
    expect(listWorkflowRuns(db, workflowId)).toHaveLength(0);
  });

  it("no room open throws", async () => {
    const { deps, rooms } = baseRunDeps();
    rooms.swapTo(null);
    await expect(startWorkflowRun(deps, "whatever", "manual", null, new Set())).rejects.toThrow(
      "No room is open."
    );
  });

  it("respects isRollingBack", async () => {
    const { deps, db } = baseRunDeps({ isRollingBack: () => true });
    const workflowId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    await expect(startWorkflowRun(deps, workflowId, "manual", null, new Set())).rejects.toThrow(
      "rolling back"
    );
  });

  it("an in-flight run: manual refuses, a schedule/agent tick silently skips", async () => {
    const { deps, db } = baseRunDeps();
    const workflowId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const job = createJob(db, "workflow", "Workflow — Digest", {}, 1);
    createWorkflowRun(db, workflowId, job, "manual", null);
    setJobStatus(db, job, "running", null);

    await expect(startWorkflowRun(deps, workflowId, "manual", null, new Set())).rejects.toThrow(
      ALREADY_RUNNING_OR_QUEUED
    );
    await expect(startWorkflowRun(deps, workflowId, "schedule", null, new Set())).resolves.toBe("");
    await expect(startWorkflowRun(deps, workflowId, "agent", null, new Set())).resolves.toBe("");
  });

  it("a full queue: manual refuses with QUEUE_FULL, a schedule tick silently skips", async () => {
    const { deps, db } = baseRunDeps();
    const workflowId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    for (let i = 0; i < 10; i++) {
      createJob(db, "download", `filler ${i}`, {}, 0);
    }
    await expect(startWorkflowRun(deps, workflowId, "manual", null, new Set())).rejects.toThrow(QUEUE_FULL);
    await expect(startWorkflowRun(deps, workflowId, "schedule", null, new Set())).resolves.toBe("");
  });

  it("throws when the room changed between the read and the mint", async () => {
    // Everything between the cheap check and the mint is AWAITED (the model
    // probe), which is exactly the window this re-check exists to close.
    const { deps, db, rooms } = baseRunDeps();
    const workflowId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const other = freshRoom("mem://a-completely-different-room");
    await expect(
      startWorkflowRun(
        {
          ...deps,
          listModels: async () => {
            rooms.swapTo(other);
            return [];
          },
        },
        workflowId,
        "manual",
        null,
        new Set()
      )
    ).rejects.toThrow(ROOM_CHANGED_STARTING);
  });

  it("workflowQueueDeps keeps a caller's own workflow starter and only fills a missing one", () => {
    const { deps } = baseRunDeps();
    const filled = workflowQueueDeps(deps);
    expect(filled.starters.has("workflow")).toBe(true);
    expect(filled).not.toBe(deps);

    const mine: RowStarter = async () => ({ kind: "immediate" });
    const withMine = { ...deps, starters: new Map<string, RowStarter>([["workflow", mine]]) };
    const kept = workflowQueueDeps(withMine);
    expect(kept.starters.get("workflow")).toBe(mine);
  });
});

// ============================================================================
// run_workflow — the manual command, including the script-consent seam
// ============================================================================

describe("runWorkflowCommand", () => {
  it("refuses a file id no longer in the room", async () => {
    const { deps, db } = baseRunDeps();
    const workflowId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    await expect(runWorkflowCommand(deps, workflowId, "nope-not-a-file")).rejects.toThrow(
      "That file is no longer in this room."
    );
  });

  it("accepts a file that exists but has no extracted text yet", async () => {
    // Rust checks extracted-text OR a bare non-trashed row; collapsing that to
    // one lookup would refuse a file mid-extraction (or accept a trashed one).
    const { deps, db } = baseRunDeps();
    const file = insertFile(db, "raw.bin", "application/octet-stream", Buffer.from([1, 2, 3]), null, "upload");
    expect(getFileExtractedText(db, file.id)).toBeNull();
    const workflowId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const jobId = await runWorkflowCommand(deps, workflowId, file.id);
    expect(jobId).not.toBe("");
    await waitUntil(() => settled(db, jobId));
  });

  it("runs for real when the definition has no script_run node — never touches the unported round trip", async () => {
    const { deps, db } = baseRunDeps();
    const workflowId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const jobId = await runWorkflowCommand(deps, workflowId, null);
    await waitUntil(() => settled(db, jobId));
    expect(getJob(db, jobId).status).toBe("done");
  });

  it("runs through with an ALREADY-approved script_run node", async () => {
    const { deps, db } = baseRunDeps();
    const bytes = Buffer.from("print('hi')\n");
    const script = insertFile(db, "hello.py", "text/x-python", bytes, "print('hi')\n", "upload");
    addScriptApproval(deps.userDataDir, scriptFingerprint(bytes));
    const workflowId = createWorkflow(db, "Runs a script", "", "", scriptDef(script.id), "user", {
      scope: "general",
    });
    const jobId = await runWorkflowCommand(deps, workflowId, null);
    expect(jobId).not.toBe("");
    await waitUntil(() => settled(db, jobId));
    // It may still fail on this machine's interpreter, but it must NOT park for
    // want of an approval it already has.
    expect(getJob(db, jobId).parkedReason ?? "").not.toContain("isn't approved on this Mac yet");
  });

  it("refuses with the honest NOT_IMPLEMENTED only when a live consent card is genuinely needed", async () => {
    const { deps, db } = baseRunDeps();
    const bin = tempDir("wf-run-fakeuv-");
    writeFileSync(path.join(bin, "uv"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    setCachedPathPrefix(bin);
    resetBinCachesForTests();
    const script = insertFile(db, "unapproved.py", "text/x-python", Buffer.from("print('new')\n"), "print('new')\n", "upload");
    const workflowId = createWorkflow(db, "Unapproved", "", "", scriptDef(script.id), "user", {
      scope: "general",
    });
    await expect(runWorkflowCommand(deps, workflowId, null)).rejects.toThrow(
      SCRIPT_APPROVAL_UI_NOT_IMPLEMENTED
    );
    expect(listWorkflowRuns(db, workflowId)).toHaveLength(0);
  });

  it("a wired scriptRunApproved seam that approves lets the run start, carrying that grant", async () => {
    const { deps, db } = baseRunDeps();
    const bin = tempDir("wf-run-fakeuv-");
    writeFileSync(path.join(bin, "uv"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    setCachedPathPrefix(bin);
    resetBinCachesForTests();
    const script = insertFile(db, "s.py", "text/x-python", Buffer.from("print(1)"), "print(1)", "upload");
    const workflowId = createWorkflow(db, "W", "", "", scriptDef(script.id), "user", { scope: "general" });
    const asked: string[] = [];
    const runDeps: RunWorkflowCommandDeps = {
      ...deps,
      scriptRunApproved: async (req) => {
        asked.push(req.interpreterLine);
        return true;
      },
    };

    const jobId = await runWorkflowCommand(runDeps, workflowId, null);
    // The card was asked with the resolved interpreter line, exactly as Rust's
    // ScriptBrief carries it.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("s.py");
    await waitUntil(() => settled(db, jobId));
    expect(getJob(db, jobId).parkedReason ?? "").not.toContain("isn't approved on this Mac yet");
  });

  it("declining the approval refuses the run, by name, and grants nothing", async () => {
    const { deps, db } = baseRunDeps();
    const bin = tempDir("wf-run-fakeuv-");
    writeFileSync(path.join(bin, "uv"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    setCachedPathPrefix(bin);
    resetBinCachesForTests();
    const script = insertFile(db, "s.py", "text/x-python", Buffer.from("x"), "x", "upload");
    const workflowId = createWorkflow(db, "W", "", "", scriptDef(script.id), "user", { scope: "general" });
    const runDeps: RunWorkflowCommandDeps = { ...deps, scriptRunApproved: async () => false };
    await expect(runWorkflowCommand(runDeps, workflowId, null)).rejects.toThrow(
      "The script “s.py” wasn't approved, so this workflow can't run."
    );
    expect(listWorkflowRuns(db, workflowId)).toHaveLength(0);
  });
});

// ============================================================================
// The command gates
// ============================================================================

describe("setWorkflowStatusCmd", () => {
  it("refuses to activate a workflow with no steps", () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "Empty", "", "", { version: 1, nodes: [], edges: [] }, "user", {
      scope: "general",
    });
    expect(() => setWorkflowStatusCmd(db, id, "active")).toThrow(/can't be activated yet/);
    expect(getWorkflow(db, id).status).toBe("draft");
  });

  it("activates a runnable workflow", () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "Runnable", "", "", branchingDef(), "user", { scope: "general" });
    setWorkflowStatusCmd(db, id, "active");
    expect(getWorkflow(db, id).status).toBe("active");
  });

  it("deactivating is always allowed, even for an unrunnable definition", () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "Empty", "", "", { version: 1, nodes: [], edges: [] }, "user", {
      scope: "general",
    });
    expect(() => setWorkflowStatusCmd(db, id, "draft")).not.toThrow();
    expect(getWorkflow(db, id).status).toBe("draft");
  });
});

describe("setWorkflowPinnedCmd", () => {
  it("refuses to pin a file-scoped workflow", () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "File-scoped", "", "", branchingDef(), "user", {
      scope: "file",
      kinds: ["pdf"],
      exts: [],
      file_id: null,
    });
    expect(() => setWorkflowPinnedCmd(db, id, true)).toThrow(/only general-purpose workflows can be pinned/);
  });

  it("pins a general workflow", () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "General", "", "", branchingDef(), "user", { scope: "general" });
    setWorkflowPinnedCmd(db, id, true);
    expect(getWorkflow(db, id).pinned).toBe(true);
  });
});

describe("setWorkflowScheduleCmd", () => {
  it("sets a daily schedule and computes its next run", () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    setWorkflowScheduleCmd(db, id, { kind: "daily", param: "08:00", enabled: true, catchUp: true });
    const sched = getSchedule(db, id);
    expect(sched?.kind).toBe("daily");
    expect(sched?.param).toBe("08:00");
    expect(sched?.nextRunAt).not.toBeNull();
  });

  it("clears a schedule with kind ''", () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    setWorkflowScheduleCmd(db, id, { kind: "daily", param: "08:00", enabled: true, catchUp: true });
    setWorkflowScheduleCmd(db, id, { kind: "", param: "", enabled: true, catchUp: true });
    expect(getSchedule(db, id)).toBeNull();
  });

  it("refuses an invalid schedule spec", () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    expect(() =>
      setWorkflowScheduleCmd(db, id, { kind: "daily", param: "not-a-time", enabled: true, catchUp: true })
    ).toThrow(/invalid/);
  });
});

describe("deleteWorkflowCmd", () => {
  it("cancels an unfinished run's flag, removes its job row, and deletes the workflow", () => {
    const { db } = freshRoom();
    const cancelState = createCancelState();
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const job = createJob(db, "workflow", "Workflow — Digest", {}, 1);
    createWorkflowRun(db, id, job, "manual", null);
    setJobStatus(db, job, "running", null);
    const flag = new CancelFlag();
    cancelState.jobCancels.set(job, flag);

    deleteWorkflowCmd(db, id, cancelState);

    expect(flag.load()).toBe(true);
    expect(() => getJob(db, job)).toThrow();
    expect(() => getWorkflow(db, id)).toThrow();
  });

  it("works with no cancelState at all (the best-effort posture)", () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    expect(() => deleteWorkflowCmd(db, id)).not.toThrow();
    expect(() => getWorkflow(db, id)).toThrow();
  });

  it("leaves a FINISHED run's job row alone — that row is Activity's history", () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const job = createJob(db, "workflow", "Workflow — Digest", {}, 1);
    createWorkflowRun(db, id, job, "manual", null);
    setJobStatus(db, job, "done", null);
    deleteWorkflowCmd(db, id);
    expect(() => getJob(db, job)).not.toThrow();
  });
});

describe("emitWorkflowsChanged", () => {
  it("emits the bare event and swallows a throwing emitter", () => {
    const events: unknown[] = [];
    emitWorkflowsChanged((event, payload) => events.push([event, payload]));
    expect(events).toEqual([["workflows-changed", undefined]]);
    expect(() =>
      emitWorkflowsChanged(() => {
        throw new Error("boom");
      })
    ).not.toThrow();
    expect(() => emitWorkflowsChanged(undefined)).not.toThrow();
  });
});

// ============================================================================
// The six agent tools
// ============================================================================

describe("WORKFLOW_NODE_REFERENCE", () => {
  it("matches the literal decoded straight out of workflow.rs (sha256 pinned)", () => {
    // Pinned as a HASH, not a prefix: the drift this caught was a single curly
    // ’ substituted for the ASCII ' in the worked example, which every
    // `toContain` in the world would have passed.
    const hash = createHash("sha256").update(WORKFLOW_NODE_REFERENCE, "utf8").digest("hex");
    expect(hash).toBe("59dce3d34cf0d6ef928a6a569b0522aa9b35a5dc8a5c06df59176ade28141f8f");
  });
});

describe("agentListWorkflows", () => {
  it("an empty room gets the node reference and a clear empty message", () => {
    const { db } = freshRoom();
    expect(agentListWorkflows(db, null)).toBe(
      `No workflows are saved in this room yet.${WORKFLOW_NODE_REFERENCE}`
    );
    expect(agentListWorkflows(db, "   ")).toBe(agentListWorkflows(db, null));
  });

  it("lists a summary line per workflow, with the reference appended exactly once", () => {
    const { db } = freshRoom();
    createWorkflow(db, "Digest", "d", "📰", branchingDef(), "agent", { scope: "general" });
    createWorkflow(db, "NoEmoji", "", "", branchingDef(), "user", { scope: "general" });
    const out = agentListWorkflows(db, null);
    expect(out).toContain("📰 Digest");
    expect(out).toContain("by agent");
    expect(out).toContain("• NoEmoji");
    expect(out.endsWith(WORKFLOW_NODE_REFERENCE)).toBe(true);
  });

  it("a named lookup returns the full definition JSON, not the summary line", () => {
    const { db } = freshRoom();
    createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const out = agentListWorkflows(db, "Digest");
    expect(out).toContain("Definition:");
    expect(out).toContain('"kind": "transform"');
  });

  it("an unknown name throws rather than fabricating a result", () => {
    const { db } = freshRoom();
    expect(() => agentListWorkflows(db, "nope")).toThrow();
  });
});

describe("agentSaveWorkflow", () => {
  it("requires a name", async () => {
    const { db } = freshRoom();
    await expect(agentSaveWorkflow(db, { definition: branchingDef() }, "agent")).rejects.toThrow(
      "save_workflow needs a `name`."
    );
  });

  it("requires a definition", async () => {
    const { db } = freshRoom();
    await expect(agentSaveWorkflow(db, { name: "X" }, "agent")).rejects.toThrow(
      "save_workflow needs a `definition` object."
    );
  });

  it("surfaces validation errors as a fixable numbered list", async () => {
    const { db } = freshRoom();
    await expect(
      agentSaveWorkflow(db, { name: "Bad", definition: danglingEdgeDef() }, "agent", {
        listModels: async () => [],
      })
    ).rejects.toThrow(/not valid yet/);
  });

  it("saves a DRAFT, applies a schedule, and broadcasts the change", async () => {
    const { db } = freshRoom();
    const emitted: Array<[string, unknown]> = [];
    const text = await agentSaveWorkflow(
      db,
      { name: "Digest", definition: branchingDef(), schedule: { kind: "daily", param: "09:00" } },
      "agent",
      { listModels: async () => [] },
      (e, p) => emitted.push([e, p])
    );
    expect(text).toContain('Saved as a DRAFT named "Digest"');
    const saved = agentListWorkflows(db, "Digest");
    expect(saved).toContain("(id ");
    expect(saved).toContain("draft");
    expect(saved).toContain("schedule: daily 09:00");
    expect(emitted).toEqual([["workflows-changed", undefined]]);
  });

  it("backfills blank node labels without mutating the caller's args", async () => {
    const { db } = freshRoom();
    const args = {
      name: "Unlabeled",
      definition: { version: 1, nodes: [{ id: "t", kind: "transform", op: "upper" }], edges: [] },
    };
    await agentSaveWorkflow(db, args, "agent", { listModels: async () => [] });
    expect(agentListWorkflows(db, "Unlabeled")).toContain('"label": "Transform text"');
    expect(args.definition.nodes[0]).not.toHaveProperty("label");
  });
});

describe("agentUpdateWorkflow", () => {
  it("drops an ACTIVE workflow back to draft — the review gate", async () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    setWorkflowStatusCmd(db, id, "active");
    const emitted: Array<[string, unknown]> = [];
    const text = await agentUpdateWorkflow(
      db,
      { name_or_id: id, definition: branchingDef() },
      { listModels: async () => [] },
      (e, p) => emitted.push([e, p])
    );
    expect(text).toContain("set it back to DRAFT");
    expect(getWorkflow(db, id).status).toBe("draft");
    expect(emitted).toEqual([["workflows-changed", undefined]]);
  });

  it("keeps the current definition when the call omits one", async () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    await agentUpdateWorkflow(db, { name_or_id: id, name: "Renamed" }, { listModels: async () => [] });
    const wf = getWorkflow(db, id);
    expect(wf.name).toBe("Renamed");
    expect(agentListWorkflows(db, id)).toContain('"kind": "transform"');
  });

  it("surfaces validation errors", async () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    await expect(
      agentUpdateWorkflow(db, { name_or_id: id, definition: danglingEdgeDef() }, { listModels: async () => [] })
    ).rejects.toThrow(/not valid/);
  });
});

describe("agentDeleteWorkflow", () => {
  it("requires a key, and never prompts without one", async () => {
    const { db } = freshRoom();
    let asked = false;
    await expect(
      agentDeleteWorkflow(db, {}, async () => {
        asked = true;
        return true;
      }, "declined")
    ).rejects.toThrow("delete_workflow needs a workflow name or id.");
    expect(asked).toBe(false);
  });

  it("respects a declined confirmation", async () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    await expect(
      agentDeleteWorkflow(db, { name_or_id: id }, async () => false, "declined-message")
    ).rejects.toThrow("declined-message");
    expect(() => getWorkflow(db, id)).not.toThrow();
  });

  it("deletes on an approved confirmation, cancelling any in-flight job", async () => {
    const { db } = freshRoom();
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const job = createJob(db, "workflow", "Workflow — Digest", {}, 1);
    createWorkflowRun(db, id, job, "manual", null);
    const cancelState = createCancelState();
    cancelState.jobCancels.set(job, new CancelFlag());
    const emitted: Array<[string, unknown]> = [];

    const text = await agentDeleteWorkflow(
      db,
      { name_or_id: id },
      async () => true,
      "declined",
      cancelState,
      (e, p) => emitted.push([e, p])
    );
    expect(text).toContain('Deleted workflow "Digest"');
    expect(() => getWorkflow(db, id)).toThrow();
    expect(cancelState.jobCancels.get(job)?.load()).toBe(true);
    expect(emitted).toEqual([["workflows-changed", undefined]]);
  });
});

describe("agentRunWorkflow", () => {
  it("refuses a draft workflow without starting anything", async () => {
    const { deps, db } = baseRunDeps();
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    await expect(agentRunWorkflow(deps, { name_or_id: id })).rejects.toThrow(/is a draft/);
    expect(listWorkflowRuns(db, id)).toHaveLength(0);
  });

  it("starts an active workflow in the background", async () => {
    const { deps, db } = baseRunDeps();
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    setWorkflowStatusCmd(db, id, "active");
    const text = await agentRunWorkflow(deps, { name_or_id: id });
    expect(text).toContain("Started");
    expect(text).toContain("Do not wait for it");
    expect(listWorkflowRuns(db, id)).toHaveLength(1);
    // Fire-and-forget, like Rust's own spawn — but this file's `afterEach`
    // removes the room's temp directory, so let it land first.
    await waitUntil(() => {
      const jobId = listWorkflowRuns(db, id)[0]?.jobId;
      return jobId !== null && jobId !== undefined && settled(db, jobId);
    });
  });
});

describe("agentTestWorkflow", () => {
  function testDeps(overrides: Partial<AgentTestWorkflowDeps> = {}): ReturnType<typeof baseRunDeps> & {
    testDeps: AgentTestWorkflowDeps;
  } {
    const base = baseRunDeps();
    return {
      ...base,
      testDeps: {
        ...base.deps,
        testTimeoutMs: 8000,
        // A real timer, just a short one: a no-op sleep would spin the poll
        // loop on the microtask queue and starve the runner it is waiting for.
        sleepMs: (_ms: number) => new Promise<void>((r) => setTimeout(r, 1)),
        ...overrides,
      },
    };
  }

  it("reports validation failure without ever running", async () => {
    const { testDeps: deps, db } = testDeps();
    const id = createWorkflow(db, "Broken", "", "", danglingEdgeDef(), "user", { scope: "general" });
    const text = await agentTestWorkflow(deps, { name_or_id: id });
    expect(text).toContain("it doesn't validate yet");
    expect(listWorkflowRuns(db, id)).toHaveLength(0);
  });

  it("refuses TERMINALLY when the single job slot is held by other work", async () => {
    const { testDeps: deps, db } = testDeps();
    deps.state.runningJob = "some-other-job";
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    await expect(agentTestWorkflow(deps, { name_or_id: id })).rejects.toThrow(
      /did NOT run.*Do not call test_workflow again this turn/s
    );
  });

  it("VALIDATED: yes on a real completed run, with a per-step report", async () => {
    const { testDeps: deps, db } = testDeps();
    const id = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const text = await agentTestWorkflow(deps, { name_or_id: id });
    expect(text).toContain("SUCCESS — every step ran.");
    expect(text).toContain("VALIDATED: yes");
    // The dead branch is reported as SKIPPED, not silently missing.
    expect(text).toContain("skipped");
    expect(text).toContain("[transform]");
    // A test never auto-activates: the user stays the activation gate.
    expect(getWorkflow(db, id).status).toBe("draft");
    // "agent", not "manual" — a test must not yank the viewer each iteration.
    expect(listWorkflowRuns(db, id)[0]?.trigger).toBe("agent");
  });

  it("VALIDATED: no on a failing node", async () => {
    const { testDeps: deps, db } = testDeps();
    const id = createWorkflow(db, "Ask agent", "", "", agentOnlyDef(), "user", { scope: "general" });
    const text = await agentTestWorkflow(deps, { name_or_id: id });
    expect(text).toContain("FAILED");
    expect(text).toContain("VALIDATED: no");
  });

  it("a parked script reports PAUSED with the script's own reason, and VALIDATED: no", async () => {
    const { testDeps: deps, db } = testDeps();
    const script = insertFile(db, "hello.py", "text/x-python", Buffer.from("print('hi')\n"), "print('hi')\n", "upload");
    const id = createWorkflow(db, "Runs a script", "", "", scriptDef(script.id), "user", { scope: "general" });
    const text = await agentTestWorkflow(deps, { name_or_id: id });
    expect(text).toContain("PAUSED — ");
    expect(text).toContain("isn't approved on this Mac yet");
    expect(text).toContain("VALIDATED: no");
  });

  it("requires a file for a run_input-bound workflow", async () => {
    const { testDeps: deps, db } = testDeps();
    const id = createWorkflow(db, "File-bound", "", "", runInputDef(), "user", FILE_BINDING);
    await expect(agentTestWorkflow(deps, { name_or_id: id })).rejects.toThrow(/runs on a chosen file/);
  });

  it("a step with no artifact is reported as '(did not run)', never as a pass", async () => {
    const { testDeps: deps, db } = testDeps();
    // Two nodes, the first of which fails — the second never runs, so it has no
    // artifact at all and must say so.
    const def: WorkflowDef = {
      version: 1,
      nodes: [
        { id: "ask", label: "", kind: "agent_run", question: "hi" },
        { id: "after", label: "", kind: "transform", op: "upper", find: null, value: null },
      ] as WorkflowDef["nodes"],
      edges: [{ from: "ask", to: "after", branch: null }],
    };
    const id = createWorkflow(db, "Two", "", "", def, "user", { scope: "general" });
    const text = await agentTestWorkflow(deps, { name_or_id: id });
    expect(text).toContain("2. (did not run)");
  });
});

// ============================================================================
// `get_job_step_artifact` (3411-3418) is a one-line `db::get_job_artifact`
// passthrough this module deliberately does NOT re-wrap — pinned here so the
// decision is a tested claim rather than a silent omission.
// ============================================================================

describe("job step artifacts", () => {
  it("read back through db-host/jobs.ts, which get_job_step_artifact wraps one-for-one", () => {
    const { db } = freshRoom();
    const jobId = createJob(db, "workflow", "t", {}, 1);
    putJobArtifact(db, jobId, 0, '{"result":"hi"}');
    expect(getJobArtifact(db, jobId, 0)).toBe('{"result":"hi"}');
    expect(getJobArtifact(db, jobId, 1)).toBeNull();
  });
});

// ============================================================================
// ADVERSARIAL: the run lifecycle, driven against a real fixture room and the
// real queue. Everything below holds a REAL runner mid-flight (through the one
// node this migration lets a test control, `http_fetch`'s injected
// `fetchPage`) so the collisions these guards exist for actually happen —
// rather than being simulated by hand-written job rows.
// ============================================================================

/** A promise the test opens by hand — the only way to hold a real runner
 * suspended inside a node while something else happens to its room. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { wait, open };
}

/** transform → http_fetch → transform. Three serial waves whose MIDDLE one is
 * under the test's control, so a run can be suspended exactly partway (one step
 * checkpointed, one in flight, one never reached). */
function fetchChainDef(): WorkflowDef {
  return {
    version: 1,
    nodes: [
      { id: "a", label: "First", kind: "transform", op: "upper", find: null, value: null },
      { id: "net", label: "Fetch it", kind: "http_fetch", url: "https://example.test/page" },
      { id: "c", label: "Last", kind: "transform", op: "lower", find: null, value: null },
    ] as WorkflowDef["nodes"],
    edges: [
      { from: "a", to: "net", branch: null },
      { from: "net", to: "c", branch: null },
    ],
  };
}

/** The done-SET a job row has checkpointed so far. */
function doneOf(db: Database.Database, jobId: string): number[] {
  const state = getJob(db, jobId).state as { done?: unknown } | null;
  const done = state !== null && typeof state === "object" ? state.done : undefined;
  return Array.isArray(done) ? (done as number[]) : [];
}

/** Wait until the fetch-chain run is suspended INSIDE its `http_fetch` node:
 * step 0 checkpointed, the job still live. */
async function suspendedInFetch(db: Database.Database, jobId: string): Promise<void> {
  await waitUntil(() => doneOf(db, jobId).length === 1 && getJob(db, jobId).status === "running");
}

describe("adversarial: starting a workflow while the room is rolling back", () => {
  it("is refused before ANYTHING is minted — no job row, no run row, no queue slot", async () => {
    let busy = true;
    const { deps, db } = baseRunDeps({ isRollingBack: () => busy });
    const wfId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });

    await expect(startWorkflowRun(deps, wfId, "manual", null, new Set())).rejects.toThrow(
      ROLLBACK_BUSY
    );
    expect(listWorkflowRuns(db, wfId)).toHaveLength(0);
    expect(listJobs(db)).toHaveLength(0);
    expect(deps.state.runningJob).toBeNull();

    // …and the gate is a state, not a verdict: the identical call runs once the
    // rollback is over.
    busy = false;
    const jobId = await startWorkflowRun(deps, wfId, "manual", null, new Set());
    expect(jobId).not.toBe("");
    await waitUntil(() => settled(db, jobId));
    expect(getJob(db, jobId).status).toBe("done");
  });

  it("refuses a scheduled/catch-up/agent tick LOUDLY too — a rollback is never a silent skip", async () => {
    // `refused()` turns an in-flight or full-queue refusal into "" for every
    // non-manual trigger. The rollback gate is checked BEFORE it and is an Err
    // for EVERY trigger, so a scheduler tick cannot mistake "the room is busy
    // rebuilding itself" for "nothing to do" and advance its own next_run_at.
    const { deps, db } = baseRunDeps({ isRollingBack: () => true });
    const wfId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    for (const trigger of ["schedule", "catchup", "agent"]) {
      await expect(startWorkflowRun(deps, wfId, trigger, null, new Set())).rejects.toThrow(
        ROLLBACK_BUSY
      );
    }
    expect(listWorkflowRuns(db, wfId)).toHaveLength(0);
  });

  it("reaches runWorkflowCommand and agentRunWorkflow too", async () => {
    const { deps, db } = baseRunDeps({ isRollingBack: () => true });
    const wfId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    setWorkflowStatusCmd(db, wfId, "active");
    await expect(runWorkflowCommand(deps, wfId, null)).rejects.toThrow(ROLLBACK_BUSY);
    await expect(agentRunWorkflow(deps, { name_or_id: "Digest" })).rejects.toThrow(ROLLBACK_BUSY);
    expect(listJobs(db)).toHaveLength(0);
  });
});

describe("adversarial: a workflow that already has a run in flight", () => {
  it("a QUEUED job blocks a second run exactly as a RUNNING one does", async () => {
    const { deps, db } = baseRunDeps();
    const wfId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const queued = createJob(db, "workflow", "Workflow — Digest", {}, 1);
    createWorkflowRun(db, wfId, queued, "schedule", null);
    expect(getJob(db, queued).status).toBe("queued");

    await expect(startWorkflowRun(deps, wfId, "manual", null, new Set())).rejects.toThrow(
      ALREADY_RUNNING_OR_QUEUED
    );
    await expect(startWorkflowRun(deps, wfId, "catchup", null, new Set())).resolves.toBe("");
    expect(listWorkflowRuns(db, wfId)).toHaveLength(1);
  });

  it("a PAUSED job does NOT block — the new run starts and retires the stale one", async () => {
    const { deps, db } = baseRunDeps();
    const wfId = createWorkflow(db, "Shout", "", "", upperTransformDef(), "user", {
      scope: "general",
    });
    const stale = createJob(db, "workflow", "Workflow — Shout", {}, 1);
    createWorkflowRun(db, wfId, stale, "manual", null);
    setJobStatus(db, stale, "paused", null);

    const jobId = await startWorkflowRun(deps, wfId, "manual", null, new Set());
    expect(jobId).not.toBe("");
    // One workflow, one live entry: the stale parked job is gone…
    expect(() => getJob(db, stale)).toThrow();
    // …but its HISTORY line survives, closed rather than left reading 'running'.
    const staleRun = listWorkflowRuns(db, wfId).find((r) => r.jobId === null || r.jobId === stale);
    expect(staleRun?.status).toBe("paused");
    await waitUntil(() => settled(db, jobId));
    expect(getJob(db, jobId).status).toBe("done");
  });

  it("a run that appears DURING the awaited model probe is caught by the second check", async () => {
    // The cheap early-out passed, then `list_models()` was awaited — the exact
    // window in which two Run-now presses a keystroke apart both got through and
    // queued the same workflow twice. Nothing may be minted for the loser.
    const { deps, db } = baseRunDeps();
    const wfId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const racing: WorkflowRunDeps = {
      ...deps,
      listModels: async () => {
        const other = createJob(db, "workflow", "Workflow — Digest", {}, 1);
        createWorkflowRun(db, wfId, other, "manual", null);
        setJobStatus(db, other, "running", null);
        return [];
      },
    };
    await expect(startWorkflowRun(racing, wfId, "manual", null, new Set())).rejects.toThrow(
      ALREADY_RUNNING_OR_QUEUED
    );
    expect(listWorkflowRuns(db, wfId)).toHaveLength(1);
    expect(listJobs(db)).toHaveLength(1);
  });

  it("…and a scheduled tick takes that same LATE refusal silently, minting nothing", async () => {
    const { deps, db } = baseRunDeps();
    const wfId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const racing: WorkflowRunDeps = {
      ...deps,
      listModels: async () => {
        const other = createJob(db, "workflow", "Workflow — Digest", {}, 1);
        createWorkflowRun(db, wfId, other, "manual", null);
        setJobStatus(db, other, "running", null);
        return [];
      },
    };
    await expect(startWorkflowRun(racing, wfId, "schedule", null, new Set())).resolves.toBe("");
    expect(listWorkflowRuns(db, wfId)).toHaveLength(1);
    expect(listJobs(db)).toHaveLength(1);
  });

  it("the queue filling DURING the probe is caught by the second capacity check too", async () => {
    const { deps, db } = baseRunDeps();
    const wfId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    let filled = false;
    const racing: WorkflowRunDeps = {
      ...deps,
      listModels: async () => {
        if (!filled) {
          filled = true;
          for (let i = 0; i < 10; i++) {
            createJob(db, "download", `filler ${i}`, {}, 0);
          }
        }
        return [];
      },
    };
    await expect(startWorkflowRun(racing, wfId, "manual", null, new Set())).rejects.toThrow(
      QUEUE_FULL
    );
    expect(listWorkflowRuns(db, wfId)).toHaveLength(0);
    await expect(startWorkflowRun(racing, wfId, "schedule", null, new Set())).resolves.toBe("");
    expect(listWorkflowRuns(db, wfId)).toHaveLength(0);
  });
});

describe("adversarial: trigger gating", () => {
  it("run_workflow is ALWAYS the manual trigger, so a collision a tick would skip is told to the user", async () => {
    const { deps, db } = baseRunDeps();
    const wfId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const running = createJob(db, "workflow", "Workflow — Digest", {}, 1);
    createWorkflowRun(db, wfId, running, "schedule", null);
    setJobStatus(db, running, "running", null);

    // The same collision, taken two ways — that is the whole point of `refused`.
    await expect(startWorkflowRun(deps, wfId, "schedule", null, new Set())).resolves.toBe("");
    await expect(runWorkflowCommand(deps, wfId, null)).rejects.toThrow(ALREADY_RUNNING_OR_QUEUED);
  });

  it("a catch-up run stamps its OWN trigger on the run row and the stored plan, and never yanks the viewer", async () => {
    const { deps, db, events } = baseRunDeps();
    const wfId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const jobId = await startWorkflowRun(deps, wfId, "catchup", null, new Set());
    await waitUntil(() => settled(db, jobId));

    expect(getJob(db, jobId).status).toBe("done");
    expect(listWorkflowRuns(db, wfId)[0]?.trigger).toBe("catchup");
    expect((getJob(db, jobId).plan as { trigger: string }).trigger).toBe("catchup");
    const finished = events.find((e) => e.finished === true);
    expect(finished).toBeDefined();
    expect(finished?.fileId ?? null).toBeNull();
  });

  it("the SAME definition run manually does carry its file — the two paths really are distinguished", async () => {
    const { deps, db, events } = baseRunDeps();
    const wfId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const jobId = await startWorkflowRun(deps, wfId, "manual", null, new Set());
    await waitUntil(() => settled(db, jobId));
    expect(events.find((e) => e.finished === true)?.fileId).toBeTruthy();
  });
});

describe("adversarial: deleting a workflow that has runs in flight", () => {
  it("mid-run delete stops the runner, drops its job row, and still frees the queue slot", async () => {
    const g = gate();
    const { deps, db, events, cancelState } = baseRunDeps({
      fetchPage: async () => {
        await g.wait;
        return { title: "T", text: "B", finalUrl: "https://example.test/page", status: 200 };
      },
    });
    const wfId = createWorkflow(db, "Fetcher", "", "", fetchChainDef(), "user", {
      scope: "general",
    });
    const jobId = await startWorkflowRun(deps, wfId, "manual", null, new Set());
    await suspendedInFetch(db, jobId);
    expect(deps.state.runningJob).toBe(jobId);

    deleteWorkflowCmd(db, wfId, cancelState);

    expect(cancelState.jobCancels.get(jobId)?.load()).toBe(true);
    expect(() => getJob(db, jobId)).toThrow();
    expect(() => getWorkflow(db, wfId)).toThrow();
    expect(listWorkflowRuns(db, wfId)).toHaveLength(0);

    g.open();
    await waitUntil(() => deps.state.runningJob === null);
    // The runner reached its own terminal epilogue even though every write in it
    // now targets rows that no longer exist.
    expect(events[events.length - 1]?.jobId).toBe(jobId);
    expect(cancelState.jobCancels.has(jobId)).toBe(false);
  });

  it("a run still QUEUED behind other work is removed as well", async () => {
    const g = gate();
    const { deps, db, cancelState } = baseRunDeps({
      fetchPage: async () => {
        await g.wait;
        return { title: "T", text: "B", finalUrl: "https://example.test/page", status: 200 };
      },
    });
    const holderId = createWorkflow(db, "Holder", "", "", fetchChainDef(), "user", {
      scope: "general",
    });
    const victimId = createWorkflow(db, "Victim", "", "", upperTransformDef(), "user", {
      scope: "general",
    });
    const holderJob = await startWorkflowRun(deps, holderId, "manual", null, new Set());
    await suspendedInFetch(db, holderJob);
    const victimJob = await startWorkflowRun(deps, victimId, "manual", null, new Set());
    expect(getJob(db, victimJob).status).toBe("queued");

    deleteWorkflowCmd(db, victimId, cancelState);
    expect(() => getJob(db, victimJob)).toThrow();
    expect(getJob(db, holderJob).status).toBe("running");

    g.open();
    await waitUntil(() => settled(db, holderJob));
  });

  it("agentDeleteWorkflow does the same behind its confirmation", async () => {
    const g = gate();
    const { deps, db, cancelState } = baseRunDeps({
      fetchPage: async () => {
        await g.wait;
        return { title: "T", text: "B", finalUrl: "https://example.test/page", status: 200 };
      },
    });
    const wfId = createWorkflow(db, "Fetcher", "", "", fetchChainDef(), "user", {
      scope: "general",
    });
    const jobId = await startWorkflowRun(deps, wfId, "manual", null, new Set());
    await suspendedInFetch(db, jobId);

    const answer = await agentDeleteWorkflow(
      db,
      { name_or_id: "Fetcher" },
      async () => true,
      "declined",
      cancelState
    );
    expect(answer).toBe('Deleted workflow "Fetcher".');
    expect(cancelState.jobCancels.get(jobId)?.load()).toBe(true);
    expect(() => getJob(db, jobId)).toThrow();

    g.open();
    await waitUntil(() => deps.state.runningJob === null);
  });
});

describe("adversarial: a node that fails partway through a real queued run", () => {
  it("the job row, its checkpoint, its artifacts and the run history all agree on where it stopped", async () => {
    const g = gate();
    const { deps, db, events, cancelState } = baseRunDeps({
      fetchPage: async () => {
        await g.wait;
        throw new Error("the page would not load");
      },
    });
    const wfId = createWorkflow(db, "Fetcher", "", "", fetchChainDef(), "user", {
      scope: "general",
    });
    const jobId = await startWorkflowRun(deps, wfId, "manual", null, new Set());
    await suspendedInFetch(db, jobId);
    g.open();
    await waitUntil(() => settled(db, jobId));

    const job = getJob(db, jobId);
    expect(job.status).toBe("error");
    expect(job.error).toBe("the page would not load");
    // A failure is not a park: nothing may claim it is waiting for approval.
    expect(job.parkedReason).toBeNull();
    // Only the wave that actually finished is checkpointed — the failing wave
    // returns BEFORE its checkpoint, so a resume re-runs it.
    expect(job.cursor).toBe(1);
    expect(job.state).toEqual({ done: [0] });

    expect(getJobArtifact(db, jobId, 0)).not.toBeNull();
    expect(getJobArtifact(db, jobId, 1)).toBeNull();
    expect(getJobArtifact(db, jobId, 2)).toBeNull();

    const runs = listWorkflowRuns(db, wfId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("error");
    expect(runs[0]?.error).toBe("the page would not load");
    expect(runs[0]?.finishedAt).not.toBeNull();

    const last = events[events.length - 1];
    expect(last?.failed).toBe(true);
    expect(last?.label).toBe("Stopped — the page would not load");
    expect(last?.done).toBe(1);
    expect(last?.total).toBe(3);

    expect(deps.state.runningJob).toBeNull();
    expect(cancelState.jobCancels.has(jobId)).toBe(false);
  });

  it("the next queued workflow still runs — a failed workflow never head-of-line-blocks", async () => {
    const g = gate();
    const { deps, db } = baseRunDeps({
      fetchPage: async () => {
        await g.wait;
        throw new Error("the page would not load");
      },
    });
    const failing = createWorkflow(db, "Fetcher", "", "", fetchChainDef(), "user", {
      scope: "general",
    });
    const waiting = createWorkflow(db, "Shout", "", "", upperTransformDef(), "user", {
      scope: "general",
    });
    const failJob = await startWorkflowRun(deps, failing, "manual", null, new Set());
    await suspendedInFetch(db, failJob);
    const waitJob = await startWorkflowRun(deps, waiting, "manual", null, new Set());
    expect(getJob(db, waitJob).status).toBe("queued");

    g.open();
    await waitUntil(() => settled(db, failJob) && settled(db, waitJob));
    expect(getJob(db, failJob).status).toBe("error");
    expect(getJob(db, waitJob).status).toBe("done");
    expect(listWorkflowRuns(db, waiting)[0]?.status).toBe("done");
    expect(deps.state.runningJob).toBeNull();
  });

  it("the second run's plan carries the FIRST successful run's start time as prev_run_at", async () => {
    const { deps, db } = baseRunDeps();
    const wfId = createWorkflow(db, "Shout", "", "", upperTransformDef(), "user", {
      scope: "general",
    });
    const first = await startWorkflowRun(deps, wfId, "manual", null, new Set());
    await waitUntil(() => settled(db, first));
    expect(getJob(db, first).status).toBe("done");
    expect((getJob(db, first).plan as { prev_run_at: string | null }).prev_run_at).toBeNull();

    const second = await startWorkflowRun(deps, wfId, "manual", null, new Set());
    const firstRun = listWorkflowRuns(db, wfId).find((r) => r.jobId === first);
    expect(firstRun?.startedAt).toBeTruthy();
    expect((getJob(db, second).plan as { prev_run_at: string | null }).prev_run_at).toBe(
      firstRun?.startedAt
    );
    await waitUntil(() => settled(db, second));
  });
});

describe("adversarial: resuming a parked workflow row through the queue's own dispatcher", () => {
  /** `http_fetch` FIRST, so a resume that wrongly re-ran the finished step
   * would call the injected fetcher a second time — the only side effect a
   * deterministic node leaves that a test can count. */
  function fetchFirstDef(): WorkflowDef {
    return {
      version: 1,
      nodes: [
        { id: "net", label: "Fetch it", kind: "http_fetch", url: "https://example.test/page" },
        { id: "c", label: "Last", kind: "transform", op: "lower", find: null, value: null },
      ] as WorkflowDef["nodes"],
      edges: [{ from: "net", to: "c", branch: null }],
    };
  }

  it("resumes from the checkpointed done-SET, re-runs nothing, and revives the SAME history line", async () => {
    let fetches = 0;
    const g = gate();
    const { deps, db, cancelState } = baseRunDeps({
      fetchPage: async () => {
        fetches += 1;
        await g.wait;
        // Stop the run the instant the node hands back: `runPlan` observes a
        // Stop at the next wave boundary, so step 0 is checkpointed and step 1
        // is never dispatched — exactly the shape a ⌘-period or a quit leaves.
        for (const flag of cancelState.jobCancels.values()) {
          flag.store(true);
        }
        return { title: "T", text: "B", finalUrl: "https://example.test/page", status: 200 };
      },
    });
    const wfId = createWorkflow(db, "Fetcher", "", "", fetchFirstDef(), "user", {
      scope: "general",
    });
    const jobId = await startWorkflowRun(deps, wfId, "manual", null, new Set());
    g.open();
    await waitUntil(() => settled(db, jobId));

    expect(getJob(db, jobId).status).toBe("paused");
    expect(getJob(db, jobId).state).toEqual({ done: [0] });
    expect(fetches).toBe(1);
    // A pause is not terminal: the run row is re-labelled, never closed.
    expect(listWorkflowRuns(db, wfId)).toHaveLength(1);
    expect(listWorkflowRuns(db, wfId)[0]?.status).toBe("paused");
    expect(listWorkflowRuns(db, wfId)[0]?.finishedAt).toBeNull();
    expect(deps.state.runningJob).toBeNull();

    // Resume exactly the way `resume_job` does: put the row back on the queue
    // and let the generic pump pick it up — no second `startWorkflowRun`.
    setJobStatus(db, jobId, "queued", null);
    await pump(workflowQueueDeps(deps));
    await waitUntil(() => settled(db, jobId));

    expect(fetches).toBe(1); // the finished step was NOT re-run
    const job = getJob(db, jobId);
    expect(job.status).toBe("done");
    expect(job.cursor).toBe(2);
    expect(job.state).toEqual({ done: [0, 1] });
    // Still ONE run: the resumed job revived its own history line rather than
    // opening a second one, and closed it this time.
    const runs = listWorkflowRuns(db, wfId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("done");
    expect(runs[0]?.finishedAt).not.toBeNull();
    expect(deps.state.runningJob).toBeNull();
  });
});

describe("adversarial: test_workflow's bounded wait", () => {
  /** One controllable node, so the whole run is a single wave. */
  function fetchOnlyDef(): WorkflowDef {
    return {
      version: 1,
      nodes: [
        { id: "net", label: "Fetch it", kind: "http_fetch", url: "https://example.test/page" },
      ] as WorkflowDef["nodes"],
      edges: [],
    };
  }

  it("a run still going when the wait ends is reported as UNKNOWN — and is genuinely told to stop", async () => {
    const g = gate();
    const base = baseRunDeps({
      fetchPage: async () => {
        await g.wait;
        return { title: "T", text: "B", finalUrl: "https://example.test/page", status: 200 };
      },
    });
    const deps: AgentTestWorkflowDeps = {
      ...base.deps,
      testTimeoutMs: 40,
      sleepMs: () => new Promise<void>((r) => setTimeout(r, 5)),
    };
    const id = createWorkflow(base.db, "Fetcher", "", "", fetchOnlyDef(), "user", {
      scope: "general",
    });

    const text = await agentTestWorkflow(deps, { name_or_id: id });
    expect(text).toContain("still running after");
    expect(text).toContain("VALIDATED: unknown");
    // A timeout is not "give up and lie about it": the run really was cancelled.
    const jobId = listWorkflowRuns(base.db, id)[0]?.jobId as string;
    expect(base.cancelState.jobCancels.get(jobId)?.load()).toBe(true);

    g.open();
    await waitUntil(() => settled(base.db, jobId));
    expect(base.deps.state.runningJob).toBeNull();
  });

  it("a run that lands in the settle window is reported as the SUCCESS it was, not a timeout", async () => {
    // Live QA 2026-07-25: the agent said "the test run timed out so it never got
    // validated" while the workflow card showed a green "Ran OK" — the run
    // finished between the last poll and the cancel taking effect. `runPlan`
    // observes a Stop only at a wave BOUNDARY, so a cancel raised while the
    // last wave is already in flight cannot stop it, and the honest answer is
    // the one the row now holds.
    const g = gate();
    const base = baseRunDeps({
      fetchPage: async () => {
        await g.wait;
        return { title: "T", text: "B", finalUrl: "https://example.test/page", status: 200 };
      },
    });
    const deps: AgentTestWorkflowDeps = {
      ...base.deps,
      testTimeoutMs: 40,
      sleepMs: async (ms: number) => {
        if (ms === 1500) {
          g.open();
          await waitUntil(() => listJobs(base.db).every((j) => settled(base.db, j.id)));
          return;
        }
        await new Promise<void>((r) => setTimeout(r, 5));
      },
    };
    const id = createWorkflow(base.db, "Fetcher", "", "", fetchOnlyDef(), "user", {
      scope: "general",
    });

    const text = await agentTestWorkflow(deps, { name_or_id: id });
    expect(text).toContain("SUCCESS — every step ran.");
    expect(text).toContain("VALIDATED: yes");
    expect(text).not.toContain("still running after");
    const jobId = listWorkflowRuns(base.db, id)[0]?.jobId as string;
    expect(getJob(base.db, jobId).status).toBe("done");
  });
});

describe("adversarial: the stored plan is an immutable snapshot", () => {
  it("editing the workflow mid-run never changes the run that is already going", async () => {
    // `WorkflowPlan`'s own doc: "the immutable plan snapshot stored on the jobs
    // row — a later edit of the workflow never corrupts a paused run." The run
    // must finish the definition it started with, not the one the agent just
    // rewrote underneath it.
    const g = gate();
    const { deps, db } = baseRunDeps({
      fetchPage: async () => {
        await g.wait;
        return { title: "T", text: "B", finalUrl: "https://example.test/page", status: 200 };
      },
    });
    const wfId = createWorkflow(db, "Fetcher", "", "", fetchChainDef(), "user", {
      scope: "general",
    });
    const jobId = await startWorkflowRun(deps, wfId, "manual", null, new Set());
    await suspendedInFetch(db, jobId);

    // Rewrite the workflow down to a single unrelated node while its run is
    // suspended inside step 2 of 3.
    await agentUpdateWorkflow(
      db,
      { name_or_id: "Fetcher", definition: upperTransformDef() },
      { listModels: async () => [] }
    );
    expect((getWorkflow(db, wfId).definition as WorkflowDef).nodes).toHaveLength(1);

    g.open();
    await waitUntil(() => settled(db, jobId));

    const job = getJob(db, jobId);
    expect(job.status).toBe("done");
    expect(job.total).toBe(3);
    expect(job.state).toEqual({ done: [0, 1, 2] });
    const plan = job.plan as { def: WorkflowDef };
    expect(plan.def.nodes.map((n) => n.id)).toEqual(["a", "net", "c"]);
    for (const step of [0, 1, 2]) {
      expect(getJobArtifact(db, jobId, step)).not.toBeNull();
    }
    expect(listWorkflowRuns(db, wfId)[0]?.status).toBe("done");
  });
});

describe("adversarial: running again after a failure", () => {
  it("a FAILED job neither blocks the next run nor survives it — but a DONE one is never touched", () => {
    // `retire_parked_jobs` skips only running/queued/DONE. An 'error' row is a
    // stale attempt the new run replaces (its Retry card would restart work the
    // user has just re-triggered by hand); a 'done' row is Activity's history.
    const { db } = freshRoom();
    const wf = createWorkflow(db, "Digest", "", "", {}, "user", { scope: "general" });
    const finished = createJob(db, "workflow", "Workflow — Digest", {}, 1);
    createWorkflowRun(db, wf, finished, "manual", null);
    setJobStatus(db, finished, "done", null);
    const failed = createJob(db, "workflow", "Workflow — Digest", {}, 1);
    createWorkflowRun(db, wf, failed, "manual", null);
    setJobStatus(db, failed, "error", "boom");

    expect(hasInflightRun(db, wf)).toBe(false);
    retireParkedJobs(db, wf);
    expect(() => getJob(db, failed)).toThrow();
    expect(() => getJob(db, finished)).not.toThrow();
  });

  it("end to end: Run again after a real failure starts, and clears the failed card", async () => {
    let calls = 0;
    const { deps, db } = baseRunDeps({
      fetchPage: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("the page would not load");
        }
        return { title: "T", text: "B", finalUrl: "https://example.test/page", status: 200 };
      },
    });
    const wfId = createWorkflow(db, "Fetcher", "", "", fetchChainDef(), "user", {
      scope: "general",
    });
    const first = await startWorkflowRun(deps, wfId, "manual", null, new Set());
    await waitUntil(() => settled(db, first));
    expect(getJob(db, first).status).toBe("error");

    const second = await startWorkflowRun(deps, wfId, "manual", null, new Set());
    expect(second).not.toBe("");
    // The failed attempt's job row is retired by the run that replaces it…
    expect(() => getJob(db, first)).toThrow();
    // …while both history lines survive, each with its own outcome.
    await waitUntil(() => settled(db, second));
    expect(getJob(db, second).status).toBe("done");
    const runs = listWorkflowRuns(db, wfId);
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.status).sort()).toEqual(["done", "error"]);
  });
});

describe("adversarial: two triggers fired without awaiting between them", () => {
  it("two Run-now presses one keystroke apart queue ONE run, not two", async () => {
    // The real shape of the race the second check exists for: both calls clear
    // the cheap early-out before either has minted anything, because everything
    // between the two checks is awaited. Two of every output file for one
    // gesture is what this used to cost.
    const { deps, db } = baseRunDeps();
    const wfId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });

    const results = await Promise.allSettled([
      startWorkflowRun(deps, wfId, "manual", null, new Set()),
      startWorkflowRun(deps, wfId, "manual", null, new Set()),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain(
      ALREADY_RUNNING_OR_QUEUED
    );

    expect(listWorkflowRuns(db, wfId)).toHaveLength(1);
    expect(listJobs(db)).toHaveLength(1);
    const jobId = (fulfilled[0] as PromiseFulfilledResult<string>).value;
    await waitUntil(() => settled(db, jobId));
    expect(getJob(db, jobId).status).toBe("done");
  });

  it("a schedule tick racing a manual press takes the loss SILENTLY", async () => {
    const { deps, db } = baseRunDeps();
    const wfId = createWorkflow(db, "Digest", "", "", branchingDef(), "user", { scope: "general" });
    const [manual, tick] = await Promise.all([
      startWorkflowRun(deps, wfId, "manual", null, new Set()),
      startWorkflowRun(deps, wfId, "schedule", null, new Set()),
    ]);
    expect(manual).not.toBe("");
    expect(tick).toBe("");
    expect(listWorkflowRuns(db, wfId)).toHaveLength(1);
    expect(listWorkflowRuns(db, wfId)[0]?.trigger).toBe("manual");
    await waitUntil(() => settled(db, manual));
  });
});
