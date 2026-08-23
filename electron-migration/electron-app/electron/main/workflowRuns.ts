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
import { type CancelFlag, type CancelState } from "./cancel.js";
import { findSourceFileLike, getFileExtractedText } from "./db-host/files.js";
import {
  checkpointJob,
  createJob,
  deleteJob,
  getJob,
  getJobArtifact,
  setJobStatus,
  setParkedReason,
  type Job,
} from "./db-host/jobs.js";
import { queryOpt } from "./db-host/util.js";
import {
  createWorkflow as dbCreateWorkflow,
  createWorkflowRun,
  deleteWorkflow as dbDeleteWorkflow,
  findWorkflow,
  finishWorkflowRunByJob,
  getSchedule,
  getWorkflow,
  listWorkflowRuns,
  listWorkflows,
  setWorkflowPinned as dbSetWorkflowPinned,
  setWorkflowRunStatusByJob,
  setWorkflowStatus as dbSetWorkflowStatus,
  updateWorkflow as dbUpdateWorkflow,
  type WorkflowRun,
} from "./db-host/workflows.js";
import { listModels as listModelsReal } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import {
  densePrefix,
  emitProgress,
  pinnedDb,
  runPlan,
  spawnJobRunner,
  type JobProgressPayload,
  type JobRunnerDeps,
  type Lane,
  type RunOutcome,
  type Step,
} from "./jobs.js";
import {
  atCapacity,
  QUEUE_FULL,
  runnerDepsFrom,
  submit,
  type JobQueueDeps,
  type RowStarter,
  type RowStartResult,
} from "./jobQueue.js";
import { interpreterLine, readScriptApprovals, stampScriptConsents } from "./scriptConsent.js";
import {
  parseScriptManifest,
  resolveInterpreter,
  resolveScriptFile,
  scriptFingerprint,
  scriptLangOf,
  type ResolvedScriptFile,
} from "./scriptRun.js";
import { ROLLBACK_BUSY } from "./turnContext.js";
import {
  applySchedule,
  backfillNodeLabels,
  clampTestReport,
  parseBinding,
  parseDef,
  scheduleFromArgs,
  testRunTrailer,
  validateWorkflowInner,
  type EmitFn,
  type ScheduleArg,
  type ValidateWorkflowInnerDeps,
} from "./workflowCompose.js";
import {
  agentRunNotImplemented,
  executeWorkflowStep,
  NEEDS_APPROVAL,
  type AgentRunFn,
  type PublishedRef,
  type WorkflowStepDeps,
} from "./workflowEngine.js";
import {
  compileWorkflow,
  DEFAULT_WF_ARTIFACT,
  defaultResolvedModel,
  defUsesRunInput,
  parseWfArtifact,
  parseWorkflowDef,
  validateRunnable,
  validateWithBinding,
  type WfArtifact,
  type WorkflowDef,
  type WorkflowPlan,
} from "./workflowModel.js";

const NO_ROOM_OPEN = "No room is open.";

// ============================================================================
// small shared helpers
// ============================================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Read an OWN string property off a model-supplied args bag. Own-key guarded
 * so a `"__proto__"`/`"constructor"`-named argument can never be read as an
 * inherited accessor (rule 2, read side). */
function argString(args: Record<string, unknown>, key: string): string | undefined {
  if (!hasOwn(args, key)) return undefined;
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

/** `args["name_or_id"].or_else(args["name"])` — how nearly every agent-tool arm
 * names the workflow it means. */
function argKey(args: Record<string, unknown>): string {
  return argString(args, "name_or_id") ?? argString(args, "name") ?? "";
}

/** `args["file"].or_else(args["file_id"])`. */
function argFile(args: Record<string, unknown>): string | undefined {
  return argString(args, "file") ?? argString(args, "file_id");
}

/** Read an OWN property (any type) off a model-supplied args bag. */
function argValue(args: Record<string, unknown>, key: string): unknown {
  return hasOwn(args, key) ? args[key] : undefined;
}

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

/** `emit_workflows_changed` (3468-3471) — the bare "the workflow list moved"
 * broadcast, best-effort exactly like Rust's `let _ = window.emit(...)`. */
export function emitWorkflowsChanged(emit?: EmitFn): void {
  emitSafely(emit, "workflows-changed", undefined);
}

// ============================================================================
// park_outcome (workflow.rs:2537-2553)
// ============================================================================

/**
 * How a finished plan actually landed, plus the reason to show for a park.
 *
 * Two different things arrive as `Error`: a Stop mid-model-call surfaces as the
 * call's own error, and a `script_run` step that parked for approval marks its
 * error with {@link NEEDS_APPROVAL}. Neither is a failing step — both are
 * pauses — but only the approval park has something to say about itself, so a
 * Stop lands with NO reason rather than borrowing the approval sentence.
 *
 * Returns Rust's own `(RunOutcome, Option<String>)` tuple shape.
 */
export function parkOutcome(
  outcome: RunOutcome,
  stopped: boolean
): readonly [RunOutcome, string | null] {
  if (outcome.kind !== "error") {
    return [outcome, null];
  }
  if (stopped) {
    return [{ kind: "paused" }, null];
  }
  if (outcome.error.startsWith(NEEDS_APPROVAL)) {
    return [{ kind: "paused" }, outcome.error.slice(NEEDS_APPROVAL.length)];
  }
  return [outcome, null];
}

// ============================================================================
// The two wire adapters (see this file's module doc)
// ============================================================================

/** `"This workflow's plan is unreadable."` — deliberately its OWN sentence,
 * NOT `jobQueue.ts`'s generic {@link UNREADABLE_PLAN}: verified against
 * `queue.rs`, where every other row-starter says "This job's plan is
 * unreadable." and only `start_workflow_row` spells it this way. */
export const WORKFLOW_PLAN_UNREADABLE = "This workflow's plan is unreadable.";

const KNOWN_LANES: ReadonlySet<string> = new Set<Lane>(["local_llm", "cpu", "cloud"]);

/** One `Step` in its STORED form — `depends_on`, as Rust's `Step` serializes. */
interface WireStep {
  id: number;
  lane: Lane;
  kind: string;
  params: unknown;
  depends_on: number[];
}

function stepToWire(step: Step): WireStep {
  return {
    id: step.id,
    lane: step.lane,
    kind: step.kind,
    params: step.params,
    depends_on: [...step.dependsOn],
  };
}

/** Read one stored step. Tolerant of BOTH key spellings (see this file's doc):
 * `depends_on` is what Rust wrote and what {@link stepToWire} writes today; a
 * `dependsOn` row could only come from an earlier build of this port, and
 * refusing to resume it would strand a real job for a field-name difference. */
function stepFromWire(raw: unknown): Step {
  if (!isPlainObject(raw)) {
    throw new Error("step is not an object");
  }
  const id = raw["id"];
  const lane = raw["lane"];
  const kind = raw["kind"];
  const deps = hasOwn(raw, "dependsOn")
    ? raw["dependsOn"]
    : hasOwn(raw, "depends_on")
      ? raw["depends_on"]
      : undefined;
  if (typeof id !== "number" || !Number.isInteger(id)) {
    throw new Error("step.id");
  }
  if (typeof lane !== "string" || !KNOWN_LANES.has(lane)) {
    throw new Error("step.lane");
  }
  if (typeof kind !== "string") {
    throw new Error("step.kind");
  }
  if (!Array.isArray(deps) || !deps.every((d) => typeof d === "number" && Number.isInteger(d))) {
    throw new Error("step.depends_on");
  }
  return { id, lane: lane as Lane, kind, params: raw["params"], dependsOn: deps as number[] };
}

/**
 * `WorkflowPlan.script_consents` (a `Map`) → the plain object the plan column
 * stores. Built on an `Object.create(null)` base, so the computed-key write
 * cannot reach `Object.prototype` even for a room file id literally named
 * `"__proto__"` — this codebase's standing rule for any object keyed by data
 * that did not originate in this process.
 */
function consentsToWire(consents: ReadonlyMap<string, string>): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const [k, v] of consents) {
    out[k] = v;
  }
  return out;
}

/** The reverse hop — own-key-guarded, so a stored blob whose `"__proto__"` is
 * an inherited accessor rather than a real own key cannot be misread as a
 * consent entry. */
function consentsFromWire(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!isPlainObject(raw)) {
    return out;
  }
  for (const k of Object.keys(raw)) {
    if (!hasOwn(raw, k)) continue;
    const v = raw[k];
    if (typeof v === "string") {
      out.set(k, v);
    }
  }
  return out;
}

/** `WorkflowPlan` → the JSON value `db::create_job`'s `plan` column stores.
 * Applies both wire hops this file owns; every other field already carries its
 * own literal (snake_case) name, per `workflowModel.ts`'s module doc. */
export function planToWire(plan: WorkflowPlan): unknown {
  return {
    workflow_id: plan.workflow_id,
    workflow_name: plan.workflow_name,
    trigger: plan.trigger,
    def: plan.def,
    resolved_model: plan.resolved_model,
    input_file_id: plan.input_file_id,
    prev_run_at: plan.prev_run_at,
    script_consents: consentsToWire(plan.script_consents),
    steps: plan.steps.map(stepToWire),
  };
}

/** A stored job row's `plan` back into a real {@link WorkflowPlan} —
 * `start_workflow_row`'s `serde_json::from_value::<WorkflowPlan>`. ANY
 * structural failure (a missing field, a step whose `depends_on` isn't an
 * array of integers, a `def` that fails `parseWorkflowDef`'s strict parse)
 * throws {@link WORKFLOW_PLAN_UNREADABLE}, exactly as Rust's
 * `.map_err(|_| …)` collapses every serde error into that one sentence. */
export function wireToPlan(raw: unknown): WorkflowPlan {
  try {
    if (!isPlainObject(raw)) {
      throw new Error("not an object");
    }
    const workflowId = raw["workflow_id"];
    const workflowName = raw["workflow_name"];
    const trigger = raw["trigger"];
    const resolvedModel = raw["resolved_model"];
    const inputFileId = raw["input_file_id"];
    const prevRunAt = raw["prev_run_at"];
    const stepsRaw = raw["steps"];
    if (
      typeof workflowId !== "string" ||
      typeof workflowName !== "string" ||
      typeof trigger !== "string" ||
      typeof resolvedModel !== "string" ||
      (inputFileId !== null && inputFileId !== undefined && typeof inputFileId !== "string") ||
      (prevRunAt !== null && prevRunAt !== undefined && typeof prevRunAt !== "string") ||
      !Array.isArray(stepsRaw)
    ) {
      throw new Error("malformed plan");
    }
    const def = parseWorkflowDef(raw["def"]);
    const steps = stepsRaw.map(stepFromWire);
    const scriptConsents = consentsFromWire(raw["script_consents"]);
    return {
      workflow_id: workflowId,
      workflow_name: workflowName,
      trigger,
      def,
      resolved_model: resolvedModel,
      input_file_id: typeof inputFileId === "string" ? inputFileId : null,
      prev_run_at: typeof prevRunAt === "string" ? prevRunAt : null,
      script_consents: scriptConsents,
      steps,
    };
  } catch {
    throw new Error(WORKFLOW_PLAN_UNREADABLE);
  }
}

/** `job.state.get("done")…unwrap_or_default()` — a resumed run's persisted
 * done-SET (never a scalar cursor; see {@link spawnWorkflowJob}'s checkpoint). */
function doneSetFromState(state: unknown): Set<number> {
  const out = new Set<number>();
  if (!isPlainObject(state)) {
    return out;
  }
  const done = state["done"];
  if (!Array.isArray(done)) {
    return out;
  }
  for (const v of done) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
      out.add(v);
    }
  }
  return out;
}

// ============================================================================
// previous_run_at / has_inflight_run / retire_parked_jobs
// ============================================================================

/**
 * The last SUCCESSFUL run's start time (for `since_last_run` /
 * `new_files_since_last_run`). Only a run that FINISHED counts: measuring from
 * a failed or stopped attempt would move the window past files that attempt
 * never processed, so they would be skipped for good with nothing to show it.
 *
 * Its own query, deliberately — NOT a filter over `listWorkflowRuns`, which is
 * capped at the 50 most recent rows (both here and in Rust): a workflow with
 * more than fifty runs since its last success would silently lose its window
 * and reprocess everything.
 */
export function previousRunAt(db: Database.Database, workflowId: string): string | null {
  try {
    return queryOpt(
      db,
      "SELECT started_at FROM workflow_runs WHERE workflow_id = ? AND status = 'done' " +
        "ORDER BY started_at DESC LIMIT 1",
      [workflowId],
      (r) => r[0] as string
    );
  } catch {
    // `.ok()` on Rust's `query_row` — never a fabricated timestamp.
    return null;
  }
}

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
export function retireParkedJobs(db: Database.Database, workflowId: string): void {
  let runs: WorkflowRun[];
  try {
    runs = listWorkflowRuns(db, workflowId);
  } catch {
    return;
  }
  for (const run of runs) {
    if (run.jobId === null) continue;
    let job: Job;
    try {
      job = getJob(db, run.jobId);
    } catch {
      continue;
    }
    if (job.status === "running" || job.status === "queued" || job.status === "done") {
      continue;
    }
    try {
      deleteJob(db, run.jobId);
    } catch {
      // best-effort, mirrors Rust's `let _ = db::delete_job(...)`.
    }
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
export function spawnWorkflowJob(
  deps: SpawnWorkflowJobDeps,
  jobId: string,
  roomPath: string,
  plan: WorkflowPlan,
  startDone: ReadonlySet<number>,
  cancel: CancelFlag
): Promise<void> {
  return spawnJobRunner(deps, jobId, roomPath, async () => {
    const startingDb = pinnedDb(deps.rooms, roomPath);
    if (startingDb !== null) {
      // Two separate `let _ = …` statements in Rust, so they stay two here: a
      // refused job-row write must not also skip the run row's revival.
      try {
        setJobStatus(startingDb, jobId, "running", null);
      } catch {
        // best-effort
      }
      try {
        // A resumed run's row was left 'paused' — put it back live.
        setWorkflowRunStatusByJob(startingDb, jobId, "running");
      } catch {
        // best-effort
      }
    }

    const steps = plan.steps;
    const total = steps.length;
    emitProgress(deps.sink, jobId, "Starting the workflow…", startDone.size, total);

    const published: PublishedRef = { value: null };
    let lastPrefix = densePrefix(startDone);

    const outcome = await runPlan(
      steps,
      startDone,
      cancel,
      (step) => executeWorkflowStep(deps, jobId, roomPath, plan, step, cancel, published),
      (done) => {
        const cursor = densePrefix(done);
        lastPrefix = cursor;
        const doneVec = Array.from(done).sort((a, b) => a - b);
        const db = pinnedDb(deps.rooms, roomPath);
        if (db !== null) {
          try {
            checkpointJob(db, jobId, cursor, { done: doneVec });
          } catch {
            // best-effort
          }
        }
      },
      (done, doneTotal) => {
        // `done` = steps completed so far; at 0 nothing has run yet, so
        // "step 0 of N" reads wrong — show "Preparing…" then 1-based.
        const label =
          done === 0
            ? "Preparing…"
            : done >= doneTotal
              ? "Finishing…"
              : `Running step ${done + 1} of ${doneTotal}…`;
        emitProgress(deps.sink, jobId, label, done, doneTotal);
      }
    );

    const [finalOutcome, parkReason] = parkOutcome(outcome, cancel.load());
    const err = finalOutcome.kind === "error" ? finalOutcome.error : null;

    const finishingDb = pinnedDb(deps.rooms, roomPath);
    if (finishingDb !== null) {
      try {
        setJobStatus(finishingDb, jobId, finalOutcome.kind, err);
      } catch {
        // best-effort
      }
      // A park is not a failure, so its reason goes in the column that means
      // "why it's paused" — the one the job card renders and `job_status`
      // reads. Written to `error` it would have the assistant tell the user
      // their workflow errored, which is the sentence this whole path exists
      // to stop saying.
      if (parkReason !== null) {
        try {
          setParkedReason(finishingDb, jobId, parkReason);
        } catch {
          // best-effort
        }
      }
      // Close the `workflow_runs` row for a terminal outcome. A PAUSE is not
      // terminal — the run can still be resumed — but it must stop reading as
      // 'running', or the history line keeps a live green dot forever with
      // nothing to explain it.
      try {
        if (finalOutcome.kind === "paused") {
          setWorkflowRunStatusByJob(finishingDb, jobId, "paused");
        } else {
          finishWorkflowRunByJob(finishingDb, jobId, finalOutcome.kind, err);
        }
      } catch {
        // best-effort
      }
    }
    deps.removeCancelFlag(jobId);

    const doneNow = lastPrefix;
    const manual = plan.trigger === "manual";
    let payload: JobProgressPayload;
    if (finalOutcome.kind === "done") {
      // Only a MANUAL run may auto-open its output — a scheduled run must
      // never yank the viewer (the [MINOR] terminal-payload fix).
      const fileId = manual ? (published.value?.id ?? null) : null;
      payload = {
        jobId,
        label: `Workflow “${plan.workflow_name}” finished`,
        done: total,
        total,
        finished: true,
        fileId,
      };
    } else if (finalOutcome.kind === "paused") {
      payload = {
        jobId,
        // Whatever parked it, in its own words. A fixed "a script step needs
        // your approval" here would be a second copy of a fact the reason
        // already states — and wrong for the park that says the script CHANGED
        // since it was approved.
        label: parkReason ?? "Paused",
        done: doneNow,
        total,
        paused: true,
      };
    } else {
      payload = {
        jobId,
        label: `Stopped — ${finalOutcome.error}`,
        done: doneNow,
        total,
        failed: true,
      };
    }
    deps.sink.emit(payload);
    emitWorkflowsChanged(deps.emit);
    // Free the queue slot and start the next waiting job.
    await deps.onSettled(jobId);
  });
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
type Refused = "inflight" | "queueFull";

/** Rust's own literal for a duplicate run. */
export const ALREADY_RUNNING_OR_QUEUED = "This workflow is already running or queued.";

/** `serde_json::from_value::<WorkflowDef>`'s fixed sentence in
 * `start_workflow_run`/`run_workflow`/`agent_test_workflow` — distinct from
 * `parse_def`'s richer, node-naming message the save/update/validate commands
 * use. */
export const DEFINITION_UNREADABLE = "this workflow's definition is unreadable";

export const ROOM_CHANGED_STARTING = "The room changed while starting this workflow.";

export const RUN_INPUT_NEEDS_FILE =
  "This workflow runs on a chosen file — start it from a file's Actions menu.";

/**
 * A refusal, said the way each trigger needs it: a scheduled/agent/catch-up
 * tick skips SILENTLY (returns `""`, and the tick still advances its own
 * `next_run_at`), a manual press is told why (throws). Ported from `refused`.
 */
function refused(why: Refused, trigger: string): string {
  if (trigger !== "manual") {
    return "";
  }
  throw new Error(why === "inflight" ? ALREADY_RUNNING_OR_QUEUED : QUEUE_FULL);
}

/**
 * Everything {@link startWorkflowRun} (and through it {@link runWorkflowCommand}
 * / {@link agentRunWorkflow} / {@link agentTestWorkflow}) needs: the full
 * job-queue seam, so the newly-minted row is handed to the SAME generic
 * dispatch a resume or a schedule tick uses, PLUS every seam a workflow's own
 * node execution needs, PLUS the small "no `AppState` port exists yet"
 * stand-ins this migration's other workflow files already established.
 */
export interface WorkflowRunDeps extends JobQueueDeps, WorkflowStepDeps {
  /** Where `script_approvals.json` lives — `read_script_approvals`'s
   * `app.path().app_data_dir()`. */
  userDataDir: string;
  /** `ollama::list_models().await.unwrap_or_default()` — real by default, and
   * every failure folds to `[]` exactly as `unwrap_or_default()` does. */
  listModels?: () => Promise<string[]>;
  /** `state.rolling_back()` — no live flag is wired through yet; defaults to
   * "never busy", the same posture `workflowCompose.ts`'s
   * `ComposeWorkflowDeps.isRollingBack` takes. */
  isRollingBack?: () => boolean;
}

/**
 * The {@link JobQueueDeps} {@link startWorkflowRun}'s `submit()` actually
 * needs: this same object, with a `"workflow"` row-starter wired against it if
 * the caller supplied none. A caller that drives other job kinds passes its own
 * full `starters` map and this leaves it untouched.
 */
export function workflowQueueDeps(deps: WorkflowRunDeps): JobQueueDeps {
  if (deps.starters.has("workflow")) {
    return deps;
  }
  const starters = new Map(deps.starters);
  starters.set("workflow", workflowRowStarter(deps));
  return {
    state: deps.state,
    rooms: deps.rooms,
    sink: deps.sink,
    cancelState: deps.cancelState,
    starters,
  };
}

/**
 * Compile a workflow and enqueue a run. Shared by the manual command, the agent
 * tools and (a future batch's) scheduler tick. `trigger` =
 * manual|schedule|catchup|agent; `inputFileId` is the header-run's current file
 * (validated by the caller for a `run_input` def); `extraConsents` are script
 * fingerprints granted for THIS invocation (a manual "run once" grant that
 * isn't in the approvals file) — folded into the plan's `script_consents`
 * alongside the per-Mac approvals file.
 *
 * Resolves to the new job id, or `""` when a NON-manual trigger was silently
 * refused (already in flight, or the queue is full); a manual trigger throws
 * instead, per {@link refused}.
 */
export async function startWorkflowRun(
  deps: WorkflowRunDeps,
  workflowId: string,
  trigger: string,
  inputFileId: string | null,
  extraConsents: ReadonlySet<string>
): Promise<string> {
  if (deps.isRollingBack?.() === true) {
    throw new Error(ROLLBACK_BUSY);
  }
  // Read the workflow + room model under one room read, then probe models off
  // it (Rust: `state.with_room(...)`, then an awaited `list_models`).
  const room0 = deps.rooms.current();
  if (room0 === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  const roomPath = room0.path;
  const wf = getWorkflow(room0.db, workflowId);
  const roomModel = modelSetting(room0.db);
  const prevRunAt = previousRunAt(room0.db, workflowId);

  let def: WorkflowDef;
  try {
    def = parseWorkflowDef(wf.definition);
  } catch {
    throw new Error(DEFINITION_UNREADABLE);
  }
  // A run_input def needs a file to run on.
  if (defUsesRunInput(def) && inputFileId === null) {
    throw new Error(RUN_INPUT_NEEDS_FILE);
  }

  // Engine-review #1: never pile up runs of the SAME workflow. Without this a
  // scheduled workflow whose runtime exceeds its interval accumulates duplicate
  // queued runs (each re-firing save_file → a growing pile of output files).
  // Also honor the shared queue cap, which the scheduler path used to bypass.
  // This is the cheap early-out — the decision that counts is taken again
  // where the row is minted, below.
  if (hasInflightRun(room0.db, workflowId)) {
    return refused("inflight", trigger);
  }
  if (atCapacity(room0.db)) {
    return refused("queueFull", trigger);
  }

  // Stamp the consent snapshot for any script_run nodes (the approvals file on
  // this Mac ∪ this invocation's grants).
  const approved = new Set<string>(readScriptApprovals(deps.userDataDir));
  for (const c of extraConsents) {
    approved.add(c);
  }
  const scriptConsents = stampScriptConsents(room0.db, def, approved);

  const models = await (deps.listModels ?? listModelsReal)().catch(() => []);
  const compiled = compileWorkflow(def, roomModel, models);
  if (!compiled.ok) {
    throw new Error(compiled.errors.join(" "));
  }
  const resolvedModel = defaultResolvedModel(roomModel, models);

  const plan: WorkflowPlan = {
    workflow_id: workflowId,
    workflow_name: wf.name,
    trigger,
    def,
    resolved_model: resolvedModel,
    input_file_id: inputFileId,
    prev_run_at: prevRunAt,
    script_consents: scriptConsents,
    steps: compiled.steps,
  };
  const total = compiled.steps.length;
  const title = `Workflow — ${wf.name}`;

  // Create the job row + open the run row, verifying the room didn't swap.
  //
  // The refusals are re-read HERE, and not only in the cheap check above:
  // everything between the two is awaited (the model probe), so two Run-now
  // presses one keystroke apart both passed that check and both queued the same
  // workflow — two of every output file for one gesture. And the parked-job
  // sweep sits after BOTH inserts, so a resumable run is only ever dropped once
  // its replacement exists: it used to be deleted before the queue cap was even
  // consulted, taking the user's Resume card with it and putting nothing in its
  // place.
  const room1 = deps.rooms.current();
  if (room1 === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  if (room1.path !== roomPath) {
    throw new Error(ROOM_CHANGED_STARTING);
  }
  if (hasInflightRun(room1.db, workflowId)) {
    return refused("inflight", trigger);
  }
  if (atCapacity(room1.db)) {
    return refused("queueFull", trigger);
  }
  const jobId = createJob(room1.db, "workflow", title, planToWire(plan), total);
  createWorkflowRun(room1.db, workflowId, jobId, trigger, inputFileId);
  // AFTER both inserts, never before: an insert that fails must leave the
  // user's Resume card where it was. The row just minted is 'queued', which the
  // sweep skips, so it cannot retire itself.
  retireParkedJobs(room1.db, workflowId);

  await submit(workflowQueueDeps(deps), jobId);
  return jobId;
}

// ============================================================================
// run_workflow (workflow.rs:3420-3458) — the UI's manual-run command
// ============================================================================

/** One `script_run` node this workflow would run that this Mac has not already
 * approved (by content hash) — what a live consent card needs to ask about. */
export interface ScriptApprovalRequest {
  fileId: string;
  name: string;
  sha: string;
  /** `interpreter_line(&runner, &name)` — "uv run --no-project x.py", the line
   * the consent card shows. Resolved BEFORE the card, exactly as Rust does. */
  interpreterLine: string;
}

/** `script_run_approved` — the live consent-card round trip. Genuinely
 * unported (its renderer round trip lives in `scripts.rs`); see this file's
 * module doc for why it is reached only for a script that ACTUALLY needs it. */
export type ScriptRunApprovedFn = (request: ScriptApprovalRequest) => Promise<boolean>;

/** The labeled reason a genuinely-unapproved `script_run` node refuses with
 * when no live consent surface is wired — never a silent skip, never a
 * fabricated approval. */
export const SCRIPT_APPROVAL_UI_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: approve_workflow_scripts' live half (script_run_approved — the " +
  "script-approve-request consent card and its renderer round trip) has no Electron port " +
  "yet. This workflow has at least one script_run node that is not yet approved on this " +
  "Mac — approve it once on the Scripts page, or wire a real scriptRunApproved seam.";

/**
 * `approve_workflow_scripts`'s DECISION half, re-derived from already-ported
 * pieces: which `script_run` nodes are not already approved on this Mac (by
 * content hash), deduped by fingerprint so a workflow running the same script
 * twice prompts once, skipping any node whose file cannot be resolved or is not
 * a recognized script language (the executor surfaces those honestly on its
 * own). Resolves each surviving node's INTERPRETER first, exactly as Rust does
 * — a missing `uv`/`python3` is an actionable error better raised before a
 * consent card than after.
 *
 * Fully real for the common case (no script node, or every one already
 * approved): returns `[]` and touches no live UI at all.
 */
function neededScriptApprovals(
  db: Database.Database,
  userDataDir: string,
  def: WorkflowDef
): ScriptApprovalRequest[] {
  const approved = new Set<string>(readScriptApprovals(userDataDir));
  const needsPrompt: ScriptApprovalRequest[] = [];
  const seen = new Set<string>();
  for (const node of def.nodes) {
    if (node.kind !== "script_run") continue;
    let resolved: ResolvedScriptFile;
    try {
      resolved = resolveScriptFile(db, node.file);
    } catch {
      continue; // unresolvable — left to the executor to surface honestly.
    }
    if (scriptLangOf(resolved.name) === null) continue;
    const sha = scriptFingerprint(resolved.bytes);
    if (approved.has(sha) || seen.has(sha)) continue;
    seen.add(sha);
    const manifest = parseScriptManifest(resolved.name, resolved.bytes.toString("utf8"));
    const runner = resolveInterpreter(manifest);
    needsPrompt.push({
      fileId: resolved.id,
      name: resolved.name,
      sha,
      interpreterLine: interpreterLine(runner, resolved.name),
    });
  }
  return needsPrompt;
}

/** Rust's own two-step "extracted text OR a bare non-trashed existence row" —
 * a file whose extraction hasn't produced text yet is still in this room. */
function fileExistsInRoom(db: Database.Database, fileId: string): boolean {
  if (getFileExtractedText(db, fileId) !== null) {
    return true;
  }
  return (
    queryOpt(db, "SELECT 1 FROM files WHERE id = ? AND trashed_at IS NULL", [fileId], () => true) ===
    true
  );
}

export interface RunWorkflowCommandDeps extends WorkflowRunDeps {
  /** See {@link ScriptRunApprovedFn}. `undefined` (no host bootstrap has wired
   * a consent card yet) refuses ONLY when a `script_run` node genuinely needs
   * approving — never a blanket refusal. */
  scriptRunApproved?: ScriptRunApprovedFn;
}

/**
 * Manually run a workflow now. `fileId` is the header-run's current file.
 *
 * A user-driven run may embed `script_run` nodes: consent for any script not
 * yet approved on this Mac is obtained here and folded into THIS run, so an
 * embedded script is runnable without a separate trip to the Scripts page while
 * still gated by explicit per-Mac consent. Without this the run parked with
 * "Script changed since it was approved" even though the script was never
 * approved at all.
 */
export async function runWorkflowCommand(
  deps: RunWorkflowCommandDeps,
  workflowId: string,
  fileId: string | null
): Promise<string> {
  const room = deps.rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  // Verify the file (if given) is still in THIS room.
  if (fileId !== null && !fileExistsInRoom(room.db, fileId)) {
    throw new Error("That file is no longer in this room.");
  }
  const wf = getWorkflow(room.db, workflowId);
  let def: WorkflowDef;
  try {
    def = parseWorkflowDef(wf.definition);
  } catch {
    throw new Error(DEFINITION_UNREADABLE);
  }

  const needsPrompt = neededScriptApprovals(room.db, deps.userDataDir, def);
  const grants = new Set<string>();
  if (needsPrompt.length > 0) {
    if (deps.scriptRunApproved === undefined) {
      throw new Error(SCRIPT_APPROVAL_UI_NOT_IMPLEMENTED);
    }
    for (const req of needsPrompt) {
      if (!(await deps.scriptRunApproved(req))) {
        // A decline aborts the run, named — Rust's own sentence.
        throw new Error(`The script “${req.name}” wasn't approved, so this workflow can't run.`);
      }
      grants.add(req.sha);
    }
  }
  return startWorkflowRun(deps, workflowId, "manual", fileId, grants);
}

// ============================================================================
// The thin commands that carry real gate logic (workflow.rs:3225-3382)
// ============================================================================

/**
 * Flip a workflow active/draft. Activating is the explicit user consent that
 * also pre-consents any scheduled/headless runs, and it is GATED on the
 * definition being runnable. It never was: the command wrote the status and
 * nothing else, so the only thing between an empty workflow and "active" was
 * the Activate button's `disabled` — driven by an async validator whose result
 * starts out empty, so it is enabled for the first frames of every draft. Live
 * QA 2026-08-03 activated a workflow with no steps through exactly that gap.
 *
 * `validateRunnable`, not `validateDefinition`: a workflow saved by an earlier
 * version may break a rule added since, and refusing to let the user
 * re-activate something already in their room is a worse failure than the rule
 * catches. Deactivating is always allowed — turning something off must never be
 * blocked.
 */
export function setWorkflowStatusCmd(db: Database.Database, id: string, status: string): void {
  const target = status === "active" ? "active" : "draft";
  if (target === "active") {
    const wf = getWorkflow(db, id);
    const def = parseDef(wf.definition);
    const runnable = validateRunnable(def);
    if (!runnable.ok) {
      throw new Error(`This workflow can't be activated yet — ${runnable.errors.join("; ")}`);
    }
  }
  dbSetWorkflowStatus(db, id, target);
}

/** Pin/unpin a workflow to the top bar. A FILE-scoped workflow already appears
 * in the file header and cannot ALSO be pinned. */
export function setWorkflowPinnedCmd(db: Database.Database, id: string, pinned: boolean): void {
  const wf = getWorkflow(db, id);
  const binding = parseBinding(wf.binding);
  if (pinned && binding.scope === "file") {
    throw new Error(
      "File-scoped workflows appear in the file header, not the top bar — only general-purpose workflows can be pinned."
    );
  }
  dbSetWorkflowPinned(db, id, pinned);
}

/** Set (or clear, with `kind: ""`) a workflow's schedule, against its CURRENT
 * stored definition. */
export function setWorkflowScheduleCmd(
  db: Database.Database,
  id: string,
  schedule: ScheduleArg
): void {
  const wf = getWorkflow(db, id);
  const def = parseDef(wf.definition);
  applySchedule(db, id, def, schedule.kind, schedule.param, schedule.enabled, schedule.catchUp);
}

/**
 * Delete a workflow: cancel + delete any unfinished job driving it, then delete
 * the row (schedules + runs cascade via FK). `cancelState` is optional — absent,
 * the in-flight job's row is still removed, just without first signalling its
 * runner to stop (the same best-effort posture Rust's own `if let Some(flag)`
 * lookup already has).
 */
export function deleteWorkflowCmd(
  db: Database.Database,
  id: string,
  cancelState?: CancelState
): void {
  const runs = listWorkflowRuns(db, id);
  for (const run of runs) {
    if (run.jobId === null) continue;
    let job: Job;
    try {
      job = getJob(db, run.jobId);
    } catch {
      continue;
    }
    if (job.status === "running" || job.status === "queued" || job.status === "paused") {
      // Signal a running job to stop, then remove the row.
      cancelState?.jobCancels.get(run.jobId)?.store(true);
      try {
        deleteJob(db, run.jobId);
      } catch {
        // best-effort
      }
    }
  }
  dbDeleteWorkflow(db, id);
}

// ============================================================================
// WORKFLOW_NODE_REFERENCE (workflow.rs:4187-4210)
// ============================================================================

/**
 * The node grammar `save_workflow` needs — served ONCE per workflow task as an
 * epilogue on the `list_workflows` index, not on every turn the workflow tier
 * is offered (2026-07-28). It used to live inside `save_workflow`'s own
 * description: 2,668 characters of DSL against 1,203 for `test_workflow` — a
 * real bill against an 8k local window, and the reason those windows kept
 * context-shifting. `list_workflows` is the right home because the Workflow
 * agent's flow opens with it as a free probe.
 *
 * Ported byte for byte: this file's test pins its sha256 against the literal
 * decoded straight out of `workflow.rs`
 * (`59dce3d3…8141f8f`), which caught a curly `’` substituted for the ASCII `'`
 * in the worked example.
 */
export const WORKFLOW_NODE_REFERENCE =
  "\n\n## Node reference (for save_workflow / update_workflow)\n" +
  "`definition` is {version, nodes, edges}; edges are [{from, to, branch?}]. Every edge OUT of a condition or a " +
  "route MUST carry `branch` (then|else for a condition, one of the route's own labels); no other edge may.\n" +
  "MODEL nodes: generate {prompt, model} · summarize_file {select} · file_pass {select, instruction, mode} · " +
  "for_each_file {select, instruction} (runs on EACH selected file) · agent_run {question} · " +
  "extract {fields:[...]} (structured JSON out of {{input}}) · route {prompt, labels:[...]} (tags input with one " +
  "label → edges use branch:<label>, an N-way condition) · vote {prompt, samples, mode:concat|majority} · " +
  "refine {prompt, rubric, max_rounds} (generate→critique→revise loop) · " +
  "plan_and_map {objective, max_workers} (decompose→work→synthesize).\n" +
  "DETERMINISTIC nodes (no model): transform {op:append|prepend|replace|upper|lower|trim|truncate|strip_html, find?, value?} · " +
  "merge {mode:concat|dedupe_lines|numbered} (join parallel branches) · http_fetch {url} · " +
  "script_run {file, mode:import|transform} (runs a room .py/.js; transform pipes {{input}}→stdin→stdout) · " +
  "save_file {name_template, format, mode} · condition {op, value}.\n" +
  "`select` types: newest | all | name_like (+pattern) | missing_summary | since_last_run | run_input — except " +
  "file_pass, which reads ONE file and rejects `all` (use for_each_file to cover every file).\n" +
  "Parallelism = several edges out of one node, re-joined by a merge. Prompts support {{input}} (upstream " +
  "results), {{files}} (file list), {{date}}. Give every node a short `label` (2-4 words in the user's " +
  'language, e.g. "Write the digest") so the canvas reads as plain steps, not kind names.\n' +
  'Set binding {"scope":"file","kinds":["pdf"]} for a workflow that runs on the file the user is looking ' +
  'at (its nodes use select {"type":"run_input"}).\n' +
  'Example: {"name":"Morning digest","emoji":"🌅","definition":{"version":1,"nodes":[' +
  '{"id":"gen","kind":"generate","label":"Write the digest","model":"auto","prompt":"Digest the new files:\\n{{files}}"},' +
  '{"id":"save","kind":"save_file","label":"Save today\'s digest","name_template":"Digest {{date}}","format":"html","mode":"create"}],' +
  '"edges":[{"from":"gen","to":"save"}]},"schedule":{"kind":"daily","param":"08:00"}}';

// ============================================================================
// The six agent tools (workflow.rs:3495-3591, 3768-4133)
// ============================================================================

/**
 * Agent tool `list_workflows`: no name → id/name/status/schedule summary lines;
 * with a name → that workflow's full definition JSON (needed for update flows).
 * The node grammar rides the INDEX, not the per-workflow fetch — an empty room
 * is the most likely place a model is about to write its first workflow, so it
 * gets the reference too. Throws (never a fabricated result) when a given name
 * matches no workflow.
 */
export function agentListWorkflows(db: Database.Database, name: string | null): string {
  // Rust filters on the TRIMMED name being non-empty but looks the workflow up
  // by the raw one — `find_workflow` does its own matching.
  if (name !== null && name.trim() !== "") {
    const wf = findWorkflow(db, name);
    const sched = getSchedule(db, wf.id);
    const schedLine = sched !== null ? ` schedule: ${sched.kind} ${sched.param}` : "";
    const defText = JSON.stringify(wf.definition, null, 2) ?? "";
    return `${wf.name} (id ${wf.id}, ${wf.status})${schedLine}\n\nDefinition:\n${defText}`;
  }
  const wfs = listWorkflows(db);
  if (wfs.length === 0) {
    return `No workflows are saved in this room yet.${WORKFLOW_NODE_REFERENCE}`;
  }
  const lines = wfs.map(
    (w) => `- ${w.emoji === "" ? "•" : w.emoji} ${w.name} (id ${w.id}, ${w.status}, by ${w.createdBy})`
  );
  return `${lines.join("\n")}${WORKFLOW_NODE_REFERENCE}`;
}

/** Agent tool `save_workflow`: validate + compile, then write a DRAFT. */
export async function agentSaveWorkflow(
  db: Database.Database,
  args: Record<string, unknown>,
  createdBy: string,
  deps: ValidateWorkflowInnerDeps = {},
  emit?: EmitFn
): Promise<string> {
  const name = (argString(args, "name") ?? "").trim();
  if (name === "") {
    throw new Error("save_workflow needs a `name`.");
  }
  const definitionRaw = argValue(args, "definition");
  if (definitionRaw === undefined) {
    throw new Error("save_workflow needs a `definition` object.");
  }
  // Rust CLONES the definition before backfilling; mutating the caller's args
  // bag would be a second, invisible effect of a "save".
  const definition = structuredClone(definitionRaw);
  backfillNodeLabels(definition);
  const def = parseDef(definition);
  const binding = parseBinding(argValue(args, "binding"));
  const errs = await validateWorkflowInner(db, def, binding, deps);
  if (errs.length > 0) {
    // The corrective-error doctrine: hand the model the numbered list to fix.
    throw new Error(
      `The workflow is not valid yet — fix these and call save_workflow again:\n- ${errs.join("\n- ")}`
    );
  }
  const id = dbCreateWorkflow(
    db,
    name,
    (argString(args, "description") ?? "").trim(),
    (argString(args, "emoji") ?? "").trim(),
    definition,
    createdBy,
    binding
  );
  const schedule = scheduleFromArgs(args);
  if (schedule !== null) {
    applySchedule(db, id, def, schedule.kind, schedule.param, schedule.enabled, schedule.catchUp);
  }
  emitWorkflowsChanged(emit);
  return `Saved as a DRAFT named "${name}". Tell the user to review and activate it on the Workflows page.`;
}

/** Agent tool `update_workflow`: same validation; an update to an ACTIVE
 * workflow drops it back to draft (its schedule pauses) — the review gate. */
export async function agentUpdateWorkflow(
  db: Database.Database,
  args: Record<string, unknown>,
  deps: ValidateWorkflowInnerDeps = {},
  emit?: EmitFn
): Promise<string> {
  const current = findWorkflow(db, argKey(args));
  const definitionRaw = argValue(args, "definition");
  // `args.get("definition").cloned().unwrap_or_else(|| current.definition)` —
  // an explicitly NULL definition is Some(Null) in Rust and fails `parse_def`
  // by name, so `?? ` (which would silently fall back) is wrong here.
  const defVal = structuredClone(definitionRaw !== undefined ? definitionRaw : current.definition);
  backfillNodeLabels(defVal);
  const def = parseDef(defVal);
  const bindingRaw = argValue(args, "binding");
  const bindingVal = bindingRaw !== undefined ? bindingRaw : current.binding;
  const binding = parseBinding(bindingVal);
  const errs = await validateWorkflowInner(db, def, binding, deps);
  if (errs.length > 0) {
    throw new Error(`The updated workflow is not valid — fix these and try again:\n- ${errs.join("\n- ")}`);
  }
  dbUpdateWorkflow(
    db,
    current.id,
    (argString(args, "name") ?? current.name).trim(),
    (argString(args, "description") ?? current.description).trim(),
    (argString(args, "emoji") ?? current.emoji).trim(),
    defVal,
    bindingVal
  );
  if (current.status === "active") {
    dbSetWorkflowStatus(db, current.id, "draft");
  }
  const schedule = scheduleFromArgs(args);
  if (schedule !== null) {
    applySchedule(
      db,
      current.id,
      def,
      schedule.kind,
      schedule.param,
      schedule.enabled,
      schedule.catchUp
    );
  }
  emitWorkflowsChanged(emit);
  return `Updated "${current.name}" and set it back to DRAFT — tell the user to review and re-activate it.`;
}

/**
 * Agent-side workflow deletion mirrors the UI command: unfinished runs are
 * cancelled before the workflow row (and its cascading schedule/history rows)
 * is removed. A separate tool on purpose, so delete is never inferred from an
 * update payload — and unrecoverable, reachable from anything the agent READ,
 * so the user's click is the undo: `confirmDestructive` has no default.
 */
export async function agentDeleteWorkflow(
  db: Database.Database,
  args: Record<string, unknown>,
  confirmDestructive: (what: string, name: string, detail: string) => Promise<boolean>,
  deleteDeclinedMessage: string,
  cancelState?: CancelState,
  emit?: EmitFn
): Promise<string> {
  const key = argKey(args).trim();
  if (key === "") {
    throw new Error("delete_workflow needs a workflow name or id.");
  }
  const workflow = findWorkflow(db, key);
  const approved = await confirmDestructive(
    "workflow",
    workflow.name,
    "Its schedule and its whole run history go with it, and any run still going is cancelled. There is no undo."
  );
  if (!approved) {
    throw new Error(deleteDeclinedMessage);
  }
  deleteWorkflowCmd(db, workflow.id, cancelState);
  emitWorkflowsChanged(emit);
  return `Deleted workflow "${workflow.name}".`;
}

/**
 * Agent tool `run_workflow`: enqueue a manual run (same trust class as
 * `start_file_pass` — started, don't poll). NEVER supplies extra script
 * consents: the SEC-1 doctrine says the UI-driving agent must not approve its
 * own code, so an unapproved `script_run` node simply parks.
 */
export async function agentRunWorkflow(
  deps: WorkflowRunDeps,
  args: Record<string, unknown>
): Promise<string> {
  const room = deps.rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  const wf = findWorkflow(room.db, argKey(args));
  if (wf.status !== "active") {
    throw new Error(
      `"${wf.name}" is a draft — the user must activate it on the Workflows page before it can run.`
    );
  }
  const fileArg = argFile(args);
  const fileId = fileArg !== undefined ? findSourceFileLike(room.db, fileArg)[0] : null;
  await startWorkflowRun(deps, wf.id, "manual", fileId, new Set());
  return `Started "${wf.name}" in the background — the user can watch it on the Workflows page. Do not wait for it.`;
}

/** `TEST_TIMEOUT_SECS = 240`, in ms. */
const TEST_TIMEOUT_MS = 240_000;

/** Deps {@link agentTestWorkflow} needs beyond {@link WorkflowRunDeps} — the
 * poll cadence, injectable so a test is fast and deterministic. */
export interface AgentTestWorkflowDeps extends WorkflowRunDeps {
  /** Defaults to {@link TEST_TIMEOUT_MS}. */
  testTimeoutMs?: number;
  /** Defaults to a real `setTimeout`-backed sleep. */
  sleepMs?: (ms: number) => Promise<void>;
}

function tryGetJob(db: Database.Database, id: string): Job | null {
  try {
    return getJob(db, id);
  } catch {
    return null;
  }
}

/** A parked run explains itself in `parked_reason`, a failed one in `error` —
 * reading the wrong column is how "PAUSED" once had to invent its reason. */
function whyOfJob(job: Job): string | null {
  return job.status === "paused" ? job.parkedReason : job.error;
}

/**
 * Agent tool `test_workflow`: the build→test→fix loop's inspection half. RUN a
 * workflow (draft OR active) to completion right now and report the outcome —
 * overall status plus EACH step's label, kind, skip and a preview of its result
 * — so the agent can see what actually failed and fix it with `update_workflow`.
 *
 * Unlike {@link agentRunWorkflow} (fire-and-forget, active-only), this waits for
 * the run and returns its results. It leaves the workflow's status untouched — a
 * tested draft stays a DRAFT, so the user remains the activation gate. Script
 * steps still need the user's approval (the agent can't self-approve code), so a
 * `script_run` node PARKS during a test, reported honestly in the result.
 */
export async function agentTestWorkflow(
  deps: AgentTestWorkflowDeps,
  args: Record<string, unknown>
): Promise<string> {
  const room0 = deps.rooms.current();
  if (room0 === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  const wf = findWorkflow(room0.db, argKey(args));
  let def: WorkflowDef;
  try {
    def = parseWorkflowDef(wf.definition);
  } catch {
    throw new Error(DEFINITION_UNREADABLE);
  }
  const binding = parseBinding(wf.binding);

  // Validate first — a compile error needs no run and names each fix.
  const validation = validateWithBinding(def, binding);
  if (!validation.ok) {
    return (
      `Test of "${wf.name}": it doesn't validate yet, so it can't run. Fix these with update_workflow, then test again:\n` +
      `- ${validation.errors.join("\n- ")}`
    );
  }

  // Deadlock-safe: only test when the single job slot is free. A test queued
  // behind a running job that is ITSELF waiting on this call (a parent
  // workflow's agent_run node) would hang — so refuse rather than queue. The
  // refusal is TERMINAL and says so: "ask the user to wait … then test again"
  // reads to a model as "retry", and the 2026-08-01 self-test burned seven
  // identical calls against that line in 90 seconds. Still an Err — the test
  // genuinely did not run — but validation HAS passed, which is the part the
  // agent was actually asked for, so say so or an honest report reads as total
  // failure.
  if (deps.state.runningJob !== null) {
    throw new Error(
      `Test of "${wf.name}" did NOT run: another background job holds the single job slot. ` +
        "Its definition validates, but it has not been test-run. Do not call test_workflow " +
        "again this turn — the slot cannot free while you wait, so every retry returns this " +
        "same line. Tell the user it is saved and valid, and that they can test-run it once " +
        "the running job finishes."
    );
  }

  // A file-scoped (run_input) workflow needs a file to run on.
  const fileArg = argFile(args);
  const fileId = fileArg !== undefined ? findSourceFileLike(room0.db, fileArg)[0] : null;
  if (defUsesRunInput(def) && fileId === null) {
    throw new Error(
      `"${wf.name}" runs on a chosen file — pass \`file\` (a file name) so the test has something to run on.`
    );
  }

  // Enqueue a real run with the "agent" trigger — NOT "manual", so a successful
  // test doesn't auto-open its output file in the viewer on every iteration. No
  // script grants — the agent can't self-approve, so any script step parks
  // (surfaced below). The slot was free, so this starts immediately.
  const jobId = await startWorkflowRun(deps, wf.id, "agent", fileId, new Set());
  if (jobId === "") {
    throw new Error("Couldn't start a test run just now — try again in a moment.");
  }

  // Poll the job to a terminal status, bounded. On timeout, cancel the run.
  const timeoutMs = deps.testTimeoutMs ?? TEST_TIMEOUT_MS;
  const sleep = deps.sleepMs ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = Date.now();
  let status = "timeout";
  let err: string | null = null;
  for (;;) {
    const room = deps.rooms.current();
    const job = room !== null ? tryGetJob(room.db, jobId) : null;
    if (job !== null) {
      if (job.status === "done") {
        status = "done";
        err = null;
        break;
      }
      if (job.status === "error" || job.status === "paused") {
        status = job.status;
        err = whyOfJob(job);
        break;
      }
    }
    if (Date.now() - started >= timeoutMs) {
      deps.cancelState.jobCancels.get(jobId)?.store(true);
      // Live QA 2026-07-25: the agent reported "the test run timed out so it
      // never got validated" while the workflow card showed a green "Ran OK" —
      // the run finished in the gap between the last poll and the cancel taking
      // effect. Read the truth one final time before reporting a failure that
      // did not happen.
      await sleep(1500);
      const settledRoom = deps.rooms.current();
      const settled = settledRoom !== null ? tryGetJob(settledRoom.db, jobId) : null;
      if (
        settled !== null &&
        (settled.status === "done" || settled.status === "error" || settled.status === "paused")
      ) {
        status = settled.status;
        err = whyOfJob(settled);
      } else {
        status = "timeout";
        err = null;
      }
      break;
    }
    await sleep(400);
  }

  // Read each step's stored artifact for a per-step report.
  const total = def.nodes.length;
  const lines: string[] = [];
  for (let i = 0; i < total; i++) {
    const room = deps.rooms.current();
    let raw: string | null = null;
    if (room !== null) {
      try {
        raw = getJobArtifact(room.db, jobId, i);
      } catch {
        raw = null;
      }
    }
    if (raw === null) {
      lines.push(`${i + 1}. (did not run)`);
      continue;
    }
    let art: WfArtifact;
    try {
      art = parseWfArtifact(JSON.parse(raw));
    } catch {
      art = DEFAULT_WF_ARTIFACT;
    }
    const label = art.node_label ?? `Step ${i + 1}`;
    const kind = art.node_kind ?? "";
    const stateStr = art.skipped ? "skipped" : "done";
    // `.chars().take(240)` — code POINTS, so a preview never splits an emoji.
    const clipped = Array.from(art.result.trim()).slice(0, 240).join("");
    const preview = clipped === "" ? "(no output)" : clipped.split("\n").join(" ");
    const kindTag = kind === "" ? "" : ` [${kind}]`;
    lines.push(`${i + 1}. ${label}${kindTag} — ${stateStr}: ${preview}`);
  }

  const header =
    status === "done"
      ? `Test of "${wf.name}": SUCCESS — every step ran.`
      : status === "error"
        ? `Test of "${wf.name}": FAILED — ${err ?? "a step errored (see steps below)"}`
        : status === "paused"
          ? // The reason is whatever parked the run — an unapproved script says
            // so itself. A run with no reason was STOPPED, and saying a script
            // needs approving there was a claim about work nobody looked at.
            err !== null
            ? `Test of "${wf.name}": PAUSED — ${err}`
            : `Test of "${wf.name}": PAUSED — it was stopped before finishing. Nothing failed.`
          : `Test of "${wf.name}": still running after ${Math.round(timeoutMs / 1000)}s — stopped waiting (it may be a heavy model step). The partial results so far:`;
  // A machine-checkable gate so the model can't paraphrase a failing run into
  // "Fixed". Only a real terminal `done` counts as validated.
  const trailer = testRunTrailer(status);
  return clampTestReport(
    `${header}\nSteps:\n${lines.join("\n")}\n\n${trailer}\n\nThe workflow stays a DRAFT for the user to review and activate.`
  );
}

// Re-exported so a caller wiring this batch's arms into `execTool.ts` (or a
// test of that wiring) needs only this module's import to supply the `agentRun`
// seam `WorkflowStepDeps` already declares.
export type { AgentRunFn };
export { agentRunNotImplemented };
