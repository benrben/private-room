/** Cohesive extraction from workflowRuns.ts; the facade preserves its public API. */
/**
 * The LAST of four slices of `src-tauri/src/commands/jobs/workflow.rs` (5855
 * lines) — the RUN GLUE. The other three are landed and committed:
 * `workflowModel.ts` (data model/validator/compiler, lines 1-1030),
 * `workflowEngine.ts` + `workflowSaveFile.ts` (the per-node execution engine,
 * lines 1031-2544) and `workflowCompose.ts` (`compose_prompt`/
 * `compose_workflow`/the template gallery PLUS `parse_def`/`human_kind_label`/
 * `backfill_node_labels`/`parse_binding`/`ScheduleArg`/`schedule_from_args`/
 * `apply_schedule`/`validate_workflow_inner`/`test_run_trailer`/
 * `clamp_test_report`/`workflow_templates` — see that file's own module doc for
 * exactly what it claims).
 *
 * THIS file is what turns those three into a runnable feature: what actually
 * STARTS a workflow run and wires it into the already-ported job queue
 * (`jobs.ts` / `jobQueue.ts` / `db-host/jobs.ts` / `db-host/workflows.ts`).
 *
 * Ported from the remaining production code in `workflow.rs`:
 *   - {@link parkOutcome} — `park_outcome` (2544-2553).
 *   - {@link spawnWorkflowJob} — `spawn_workflow_job` (2560-2748): THE critical
 *     piece. Drives `workflowEngine.ts`'s {@link executeWorkflowStep} through
 *     `jobs.ts`'s {@link runPlan}, checkpoints the DONE-SET, reports progress,
 *     writes the terminal job + `workflow_runs` status, emits the terminal
 *     `job-progress` payload and frees the queue slot.
 *   - {@link previousRunAt} — `previous_run_at` (2782-2790).
 *   - `Refused`/`refused` (2794-2812) — the refusal vocabulary.
 *   - {@link startWorkflowRun} — `start_workflow_run` (2821-2939): compile +
 *     mint + enqueue, shared by the manual command, the agent tools and (a
 *     future batch's) scheduler tick.
 *   - {@link hasInflightRun} (3312-3323) / {@link retireParkedJobs}
 *     (3337-3356) — the duplicate-run and parked-pile-up guards.
 *   - {@link setWorkflowStatusCmd} (3239-3263), {@link setWorkflowPinnedCmd}
 *     (3265-3281), {@link setWorkflowScheduleCmd} (3283-3302),
 *     {@link deleteWorkflowCmd} (3358-3382) — thin, but each with real gate
 *     logic on top of `db-host/workflows.ts`.
 *   - {@link runWorkflowCommand} — `run_workflow` (3421-3458).
 *   - {@link emitWorkflowsChanged} — `emit_workflows_changed` (3468-3471).
 *   - {@link WORKFLOW_NODE_REFERENCE} (4187-4210) and all six agent-tool
 *     bodies: {@link agentListWorkflows} (3497-3543),
 *     {@link agentSaveWorkflow} (3546-3591), {@link agentUpdateWorkflow}
 *     (3770-3833), {@link agentDeleteWorkflow} (3843-3889),
 *     {@link agentRunWorkflow} (3893-3929), {@link agentTestWorkflow}
 *     (3941-4133) — the exact six names `execTool.ts` stubbed as
 *     "NOT_IMPLEMENTED: … Batch C", wired for real.
 *
 * NOT re-ported here, because another landed file's own module doc claims it:
 * `parse_def`/`backfill_node_labels`/`parse_binding`/`validate_workflow_inner`/
 * `apply_schedule`/`ScheduleArg`/`schedule_from_args`/`test_run_trailer`/
 * `clamp_test_report`/`builtin_templates` — `workflowCompose.ts`.
 * `execute_workflow_step`/`run_workflow_node` and every node arm —
 * `workflowEngine.ts`. `WorkflowDef`/`WorkflowPlan`/`compile_workflow`/
 * `default_resolved_model`/`def_uses_run_input`/`validate_with_binding`/
 * `validate_runnable`/`WfArtifact` — `workflowModel.ts`.
 * `stamp_script_consents`/`resolve_script_file`/`script_fingerprint`/
 * `read_script_approvals` — `scriptConsent.ts`/`scriptRun.ts`.
 * `workflow_tools_specs` — `toolSpecs.ts`'s `workflowToolsSpecs()`.
 *
 * DELIBERATELY NOT WRAPPED: `list_workflows`/`get_workflow`/
 * `get_workflow_schedule`/`get_workflow_runs`/`get_job_step_artifact`
 * (3384-3418) are one-line `db::` passthroughs with no orchestration of their
 * own — `db-host/workflows.ts`'s `listWorkflows`/`getWorkflow`/`getSchedule`/
 * `listWorkflowRuns` and `db-host/jobs.ts`'s `getJobArtifact` already answer
 * them. A second, do-nothing wrapper here would be a duplicate DB seam that
 * can only drift.
 *
 * ============================================================================
 * HOW THIS PLUGS INTO THE JOB QUEUE
 * ============================================================================
 * A workflow does NOT bypass the queue's per-kind dispatch: Rust's
 * `start_workflow_run` mints the job row and calls `queue::submit`, which
 * reaches `spawn_workflow_job` only through the generic `start_job_from_row` →
 * `start_workflow_row` path (the one that deserializes a `WorkflowPlan` back
 * OUT of the row it just wrote). So {@link startWorkflowRun} calls
 * `jobQueue.ts`'s real {@link submit}, and {@link workflowRowStarter} is the
 * `"workflow"` {@link RowStarter} — the SAME starter serving a fresh run, an
 * app-restart resume and a schedule tick, exactly as Rust's single
 * `start_workflow_row` does.
 *
 * WIRING HAZARD for a host bootstrap: the app-wide `JobQueueDeps.starters` map
 * must carry `["workflow", workflowRowStarter(engineDeps)]`, or a workflow row
 * left `queued` is poisoned by `jobQueue.ts`'s `notImplementedRowStarter` the
 * moment any later `pump()` reaches it. {@link workflowQueueDeps} closes that
 * hazard for the run this module starts itself (it registers the starter from
 * the very deps object it was handed if the caller supplied none), but a pump
 * driven from somewhere else still uses whatever map that caller built.
 *
 * ============================================================================
 * THE TWO WIRE ADAPTERS THIS BATCH OWNS
 * ============================================================================
 * `workflowModel.ts`'s and `jobs.ts`'s module docs each flag one of these as
 * "whichever future batch persists/reads a WorkflowPlan owns this hop". That
 * batch is this one, and both hops live in exactly two functions:
 *
 *   1. `Step.dependsOn` (this port's RUNTIME camelCase — `jobs.ts`'s own
 *      `Step`) ↔ `depends_on`, which is what the Rust `Step` struct actually
 *      serializes (no `#[serde(rename_all)]` on it). {@link planToWire} WRITES
 *      `depends_on`, so a row this Electron build mints is byte-compatible with
 *      the shape `jobs.ts`'s doc promises every reader; {@link wireToPlan}
 *      accepts EITHER key on read (preferring `dependsOn` if both are somehow
 *      present) so a plan written by an older build of this port still resumes.
 *   2. `WorkflowPlan.script_consents` is a `Map` in memory but a plain JSON
 *      object on the wire (Rust's `HashMap<String,String>` serde shape). Its
 *      keys are room-controlled file ids, so per this codebase's standing rule
 *      the write side builds on an `Object.create(null)` base and the read side
 *      iterates own keys only — a stored `"__proto__"` entry can never become a
 *      prototype accessor in either direction (pinned by this file's tests).
 *
 * ============================================================================
 * THE ONE GENUINELY UNPORTED DEPENDENCY THIS FILE TOUCHES
 * ============================================================================
 * `run_workflow`'s Rust body calls `approve_workflow_scripts`
 * (`commands/scripts.rs:194-247`), whose live consent-card round trip
 * (`script_run_approved`) has no Electron port — `scriptConsent.ts` says so
 * itself. Calling that blanket stub here would refuse EVERY manual run,
 * including the overwhelming majority with no `script_run` node at all, which
 * is a strictly worse answer than the real command gives. So
 * {@link neededScriptApprovals} re-derives that function's real DECISION half
 * out of already-ported pieces (`resolveScriptFile`/`scriptLangOf`/
 * `scriptFingerprint`/`readScriptApprovals`), including its
 * resolve-the-interpreter-BEFORE-the-card step so a genuinely missing
 * `uv`/`python3` still surfaces as its own actionable error, and only a node
 * that truly needs a live prompt reaches the injectable
 * {@link ScriptRunApprovedFn} seam — or, with no seam wired, the one honest
 * {@link SCRIPT_APPROVAL_UI_NOT_IMPLEMENTED} refusal this file ever raises.
 * `agentRunWorkflow`/`agentTestWorkflow` never call it at all, matching Rust:
 * the SEC-1 doctrine says an agent-triggered run must not approve its own code,
 * so an unapproved script simply PARKS through the `NEEDS_APPROVAL` path
 * {@link parkOutcome} already classifies.
 */
import type Database from "better-sqlite3-multiple-ciphers";
import { type CancelFlag } from "./cancel.js";
import { checkpointJob, deleteJob, getJob, setJobStatus, setParkedReason, type Job } from "./db-host/jobs.js";
import { finishWorkflowRunByJob, listWorkflowRuns, setWorkflowRunStatusByJob, type WorkflowRun } from "./db-host/workflows.js";
import { densePrefix, emitProgress, pinnedDb, runPlan, spawnJobRunner, type JobProgressPayload, type JobRunnerDeps, type RunOutcome } from "./jobs.js";
import { runnerDepsFrom, type RowStarter, type RowStartResult } from "./jobQueue.js";
import { executeWorkflowStep, type PublishedRef, type WorkflowStepDeps } from "./workflowEngine.js";
import { type WorkflowPlan } from "./workflowModel.js";
import { doneSetFromState, emitWorkflowsChanged, parkOutcome, wireToPlan, WORKFLOW_PLAN_UNREADABLE } from "./workflowRunsPlan.js";


/**
 * True if this workflow already has a job in flight (running or queued) — the
 * guard against duplicate/pile-up runs.
 *
 * A PAUSED job is deliberately NOT in flight: it makes no progress on its own,
 * so counting it here parked the workflow forever — every scheduled tick
 * skipped silently and Run answered "already running or queued" for a job that
 * was never going to move. The parked job stays resumable either way.
 */
export function hasInflightRun(db: Database.Database, workflowId: string): boolean {
  let runs: WorkflowRun[];
  try {
    runs = listWorkflowRuns(db, workflowId);
  } catch {
    return false;
  }
  return runs.some((r) => {
    if (r.jobId === null) return false;
    try {
      const job = getJob(db, r.jobId);
      return job.status === "running" || job.status === "queued";
    } catch {
      return false;
    }
  });
}


/**
 * Retire this workflow's PARKED jobs, because a fresh run is about to start.
 *
 * A parked job rightly does not block a new run, but nothing cleared it either,
 * so every trigger that found one added a second parked job beside it, then a
 * third. Starting a run is the statement that the stale attempt is no longer
 * wanted — one workflow, one live entry. Never touches a running/queued job (the
 * in-flight check has already refused to run alongside those) nor a `'done'`
 * one: since decision #12 the `jobs` table IS Activity's history, so a finished
 * row is the log's evidence that the run happened, not a stale attempt. The
 * run's history line survives regardless — that lives in `workflow_runs`.
 */
function workflowRunsOrEmpty(db: Database.Database, workflowId: string): WorkflowRun[] {
  try {
    return listWorkflowRuns(db, workflowId);
  } catch {
    return [];
  }
}


export function jobForWorkflowRun(db: Database.Database, run: WorkflowRun): Job | null {
  if (run.jobId === null) {
    return null;
  }
  try {
    return getJob(db, run.jobId);
  } catch {
    return null;
  }
}


function isParkedWorkflowJob(job: Job): boolean {
  return job.status !== "running" && job.status !== "queued" && job.status !== "done";
}


export function deleteJobBestEffort(db: Database.Database, jobId: string): void {
  try {
    deleteJob(db, jobId);
  } catch {
    // best-effort, mirrors Rust's `let _ = db::delete_job(...)`.
  }
}


function retireParkedWorkflowRun(db: Database.Database, run: WorkflowRun): void {
  const job = jobForWorkflowRun(db, run);
  if (job === null || !isParkedWorkflowJob(job) || run.jobId === null) {
    return;
  }
  deleteJobBestEffort(db, run.jobId);
}


export function retireParkedJobs(db: Database.Database, workflowId: string): void {
  for (const run of workflowRunsOrEmpty(db, workflowId)) {
    retireParkedWorkflowRun(db, run);
  }
}


// ============================================================================
// spawn_workflow_job (workflow.rs:2555-2748) — THE CRITICAL PIECE
// ============================================================================

/** Everything {@link spawnWorkflowJob} needs beyond its own arguments: the
 * generic job-runner plumbing ({@link JobRunnerDeps}) plus every seam
 * {@link executeWorkflowStep} takes ({@link WorkflowStepDeps}). Both declare
 * `rooms`, and it is the same `RoomSource` — one object satisfies both. */
export interface SpawnWorkflowJobDeps extends JobRunnerDeps, WorkflowStepDeps {}


/**
 * Spawn the checkpointed runner for a workflow job (fresh or resumed). Mirrors
 * `spawn_file_pass`: status → running, per-wave checkpoint persists the
 * DONE-SET (a workflow's branched multi-lane plan needs the real set, not a
 * cursor), the terminal payload carries the published file only for a MANUAL
 * run (a scheduled run must not yank the viewer).
 *
 * Every DB write in the epilogue is best-effort, matching Rust's `let _ = …` on
 * each of them: a room that swapped or refused a write must not cost the queue
 * its terminal event or its slot.
 *
 * Returns the settled promise (like `jobDownload.ts`'s `spawnDownload`) so a
 * test can await the whole lifecycle; real callers fire and forget, exactly as
 * Rust never joins the spawned task.
 */
interface WorkflowJobProgress {
  published: PublishedRef;
  lastPrefix: number;
}


function reviveWorkflowJob(db: Database.Database, jobId: string): void {
  try {
    setJobStatus(db, jobId, "running", null);
  } catch {
    // best-effort
  }
  try {
    setWorkflowRunStatusByJob(db, jobId, "running");
  } catch {
    // best-effort
  }
}


function reviveWorkflowJobInRoom(deps: SpawnWorkflowJobDeps, jobId: string, roomPath: string): void {
  const db = pinnedDb(deps.rooms, roomPath);
  if (db !== null) {
    reviveWorkflowJob(db, jobId);
  }
}


function checkpointWorkflowProgress(
  deps: SpawnWorkflowJobDeps,
  jobId: string,
  roomPath: string,
  progress: WorkflowJobProgress,
  done: ReadonlySet<number>
): void {
  const cursor = densePrefix(done);
  progress.lastPrefix = cursor;
  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) {
    return;
  }
  try {
    checkpointJob(db, jobId, cursor, { done: Array.from(done).sort((a, b) => a - b) });
  } catch {
    // best-effort
  }
}


function workflowProgressLabel(done: number, total: number): string {
  if (done === 0) {
    return "Preparing…";
  }
  if (done >= total) {
    return "Finishing…";
  }
  return `Running step ${done + 1} of ${total}…`;
}


function reportWorkflowProgress(
  deps: SpawnWorkflowJobDeps,
  jobId: string,
  done: number,
  total: number
): void {
  emitProgress(deps.sink, jobId, workflowProgressLabel(done, total), done, total);
}


function runWorkflowPlan(
  deps: SpawnWorkflowJobDeps,
  jobId: string,
  roomPath: string,
  plan: WorkflowPlan,
  startDone: ReadonlySet<number>,
  cancel: CancelFlag,
  progress: WorkflowJobProgress
): Promise<RunOutcome> {
  return runPlan(
    plan.steps,
    startDone,
    cancel,
    (step) => executeWorkflowStep(deps, jobId, roomPath, plan, step, cancel, progress.published),
    (done) => checkpointWorkflowProgress(deps, jobId, roomPath, progress, done),
    (done, total) => reportWorkflowProgress(deps, jobId, done, total)
  );
}


function workflowOutcomeError(outcome: RunOutcome): string | null {
  return outcome.kind === "error" ? outcome.error : null;
}


function setWorkflowJobStatus(db: Database.Database, jobId: string, outcome: RunOutcome, error: string | null): void {
  try {
    setJobStatus(db, jobId, outcome.kind, error);
  } catch {
    // best-effort
  }
}


function setWorkflowParkReason(db: Database.Database, jobId: string, reason: string | null): void {
  if (reason === null) {
    return;
  }
  try {
    setParkedReason(db, jobId, reason);
  } catch {
    // best-effort
  }
}


function setWorkflowRunOutcome(db: Database.Database, jobId: string, outcome: RunOutcome, error: string | null): void {
  try {
    if (outcome.kind === "paused") {
      setWorkflowRunStatusByJob(db, jobId, "paused");
      return;
    }
    finishWorkflowRunByJob(db, jobId, outcome.kind, error);
  } catch {
    // best-effort
  }
}


function persistWorkflowOutcome(
  deps: SpawnWorkflowJobDeps,
  jobId: string,
  roomPath: string,
  outcome: RunOutcome,
  error: string | null,
  parkReason: string | null
): void {
  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) {
    return;
  }
  setWorkflowJobStatus(db, jobId, outcome, error);
  setWorkflowParkReason(db, jobId, parkReason);
  setWorkflowRunOutcome(db, jobId, outcome, error);
}


function manualPublishedFileId(plan: WorkflowPlan, published: PublishedRef): string | null {
  if (plan.trigger !== "manual") {
    return null;
  }
  return published.value?.id ?? null;
}


function successfulWorkflowPayload(jobId: string, plan: WorkflowPlan, total: number, published: PublishedRef): JobProgressPayload {
  return {
    jobId,
    label: `Workflow “${plan.workflow_name}” finished`,
    done: total,
    total,
    finished: true,
    fileId: manualPublishedFileId(plan, published),
  };
}


function pausedWorkflowPayload(jobId: string, done: number, total: number, reason: string | null): JobProgressPayload {
  return { jobId, label: reason ?? "Paused", done, total, paused: true };
}


function failedWorkflowPayload(jobId: string, done: number, total: number, outcome: Extract<RunOutcome, { kind: "error" }>): JobProgressPayload {
  return { jobId, label: `Stopped — ${outcome.error}`, done, total, failed: true };
}


function workflowCompletionPayload(
  jobId: string,
  plan: WorkflowPlan,
  total: number,
  progress: WorkflowJobProgress,
  outcome: RunOutcome,
  parkReason: string | null
): JobProgressPayload {
  if (outcome.kind === "done") {
    return successfulWorkflowPayload(jobId, plan, total, progress.published);
  }
  if (outcome.kind === "paused") {
    return pausedWorkflowPayload(jobId, progress.lastPrefix, total, parkReason);
  }
  return failedWorkflowPayload(jobId, progress.lastPrefix, total, outcome);
}


async function runSpawnedWorkflowJob(
  deps: SpawnWorkflowJobDeps,
  jobId: string,
  roomPath: string,
  plan: WorkflowPlan,
  startDone: ReadonlySet<number>,
  cancel: CancelFlag
): Promise<void> {
  reviveWorkflowJobInRoom(deps, jobId, roomPath);
  const total = plan.steps.length;
  emitProgress(deps.sink, jobId, "Starting the workflow…", startDone.size, total);
  const progress: WorkflowJobProgress = { published: { value: null }, lastPrefix: densePrefix(startDone) };
  const outcome = await runWorkflowPlan(deps, jobId, roomPath, plan, startDone, cancel, progress);
  const [finalOutcome, parkReason] = parkOutcome(outcome, cancel.load());
  persistWorkflowOutcome(deps, jobId, roomPath, finalOutcome, workflowOutcomeError(finalOutcome), parkReason);
  deps.removeCancelFlag(jobId);
  deps.sink.emit(workflowCompletionPayload(jobId, plan, total, progress, finalOutcome, parkReason));
  emitWorkflowsChanged(deps.emit);
  await deps.onSettled(jobId);
}


export function spawnWorkflowJob(
  deps: SpawnWorkflowJobDeps,
  jobId: string,
  roomPath: string,
  plan: WorkflowPlan,
  startDone: ReadonlySet<number>,
  cancel: CancelFlag
): Promise<void> {
  return spawnJobRunner(deps, jobId, roomPath, () =>
    runSpawnedWorkflowJob(deps, jobId, roomPath, plan, startDone, cancel)
  );
}


// ============================================================================
// start_workflow_row (queue.rs) — the queue's RowStarter
// ============================================================================

/**
 * The queue's `"workflow"` {@link RowStarter}. Rebuilds a {@link WorkflowPlan}
 * from the job's own immutable, persisted plan — a fresh run
 * {@link startWorkflowRun} just minted, an app-restart resume, or a schedule
 * tick — and spawns {@link spawnWorkflowJob}. `engineDeps` is closed over at
 * registration time, mirroring `podcastAudioRowStarter`'s `render` /
 * `downloadRowStarter`'s `engineDeps`, rather than threaded through the plain
 * {@link JobQueueDeps} the whole registry shares.
 */
export function workflowRowStarter(engineDeps: Omit<WorkflowStepDeps, "rooms">): RowStarter {
  return async (deps, job, roomPath, cancel): Promise<RowStartResult> => {
    let plan: WorkflowPlan;
    try {
      plan = wireToPlan(job.plan);
    } catch {
      return { kind: "error", message: WORKFLOW_PLAN_UNREADABLE };
    }
    const startDone = doneSetFromState(job.state);
    // `runnerDepsFrom` spreads LAST on purpose: the QUEUE's own room source,
    // progress sink, cancel-flag registry and `onSettled` are authoritative, so
    // an `engineDeps` that happens to carry its own `rooms` (e.g. the very
    // `WorkflowRunDeps` `startWorkflowRun` registers) can never wire a runner to
    // a different registry than the one holding its cancel flag.
    void spawnWorkflowJob(
      { ...engineDeps, ...runnerDepsFrom(deps) },
      job.id,
      roomPath,
      plan,
      startDone,
      cancel
    );
    return { kind: "runner" };
  };
}


// ============================================================================
// start_workflow_run (workflow.rs:2814-2939)
// ============================================================================

/** Why a trigger did not start a run. */
export type Refused = "inflight" | "queueFull";
