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
import { createJob } from "./db-host/jobs.js";
import { createWorkflowRun, getWorkflow, type Workflow } from "./db-host/workflows.js";
import { listModels as listModelsReal } from "./engineRouting.js";
import { modelSetting } from "./gatherContext.js";
import { type RoomHandle } from "./jobs.js";
import { atCapacity, QUEUE_FULL, submit, type JobQueueDeps } from "./jobQueue.js";
import { readScriptApprovals, stampScriptConsentsInRoom } from "./scriptConsent.js";
import { ROLLBACK_BUSY } from "./turnContext.js";
import { type WorkflowStepDeps } from "./workflowEngine.js";
import { compileWorkflow, defaultResolvedModel, defUsesRunInput, parseWorkflowDef, type WorkflowDef, type WorkflowPlan } from "./workflowModel.js";
import { hasInflightRun, type Refused, retireParkedJobs, workflowRowStarter } from "./workflowRunsJob.js";
import { NO_ROOM_OPEN, planToWire, previousRunAt } from "./workflowRunsPlan.js";


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
interface WorkflowRunStartContext {
  room: RoomHandle;
  roomPath: string;
  workflow: Workflow;
  definition: WorkflowDef;
  roomModel: string | null;
  previousRunAt: string | null;
}


function assertWorkflowRunNotRollingBack(deps: WorkflowRunDeps): void {
  if (deps.isRollingBack?.() === true) {
    throw new Error(ROLLBACK_BUSY);
  }
}


export function readableWorkflowDefinition(workflow: Workflow): WorkflowDef {
  try {
    return parseWorkflowDef(workflow.definition);
  } catch {
    throw new Error(DEFINITION_UNREADABLE);
  }
}


function initialWorkflowRunContext(deps: WorkflowRunDeps, workflowId: string): WorkflowRunStartContext {
  const room = deps.rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  const workflow = getWorkflow(room.db, workflowId);
  return {
    room,
    roomPath: room.path,
    workflow,
    definition: readableWorkflowDefinition(workflow),
    roomModel: modelSetting(room.db),
    previousRunAt: previousRunAt(room.db, workflowId),
  };
}


function assertWorkflowInput(definition: WorkflowDef, inputFileId: string | null): void {
  if (defUsesRunInput(definition) && inputFileId === null) {
    throw new Error(RUN_INPUT_NEEDS_FILE);
  }
}


function workflowRunRefusal(db: Database.Database, workflowId: string): Refused | null {
  if (hasInflightRun(db, workflowId)) {
    return "inflight";
  }
  if (atCapacity(db)) {
    return "queueFull";
  }
  return null;
}


function refusedWorkflowRun(db: Database.Database, workflowId: string, trigger: string): string | null {
  const reason = workflowRunRefusal(db, workflowId);
  return reason === null ? null : refused(reason, trigger);
}


function approvedWorkflowScripts(userDataDir: string, extraConsents: ReadonlySet<string>): Set<string> {
  const approved = new Set<string>(readScriptApprovals(userDataDir));
  for (const c of extraConsents) {
    approved.add(c);
  }
  return approved;
}


async function modelsForWorkflowRun(deps: WorkflowRunDeps): Promise<string[]> {
  return (deps.listModels ?? listModelsReal)().catch(() => []);
}


async function workflowRunPlan(
  deps: WorkflowRunDeps,
  workflowId: string,
  trigger: string,
  inputFileId: string | null,
  extraConsents: ReadonlySet<string>,
  context: WorkflowRunStartContext
): Promise<WorkflowPlan> {
  const approved = approvedWorkflowScripts(deps.userDataDir, extraConsents);
  const scriptConsents = await stampScriptConsentsInRoom(context.room, context.definition, approved);
  const models = await modelsForWorkflowRun(deps);
  const compiled = compileWorkflow(context.definition, context.roomModel, models);
  if (!compiled.ok) {
    throw new Error(compiled.errors.join(" "));
  }
  return {
    workflow_id: workflowId,
    workflow_name: context.workflow.name,
    trigger,
    def: context.definition,
    resolved_model: defaultResolvedModel(context.roomModel, models),
    input_file_id: inputFileId,
    prev_run_at: context.previousRunAt,
    script_consents: scriptConsents,
    steps: compiled.steps,
  };
}


function currentWorkflowRunRoom(deps: WorkflowRunDeps, roomPath: string): RoomHandle {
  const room = deps.rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  if (room.path !== roomPath) {
    throw new Error(ROOM_CHANGED_STARTING);
  }
  return room;
}


async function enqueueWorkflowRun(
  deps: WorkflowRunDeps,
  room: RoomHandle,
  workflowId: string,
  trigger: string,
  inputFileId: string | null,
  plan: WorkflowPlan
): Promise<string> {
  const jobId = createJob(room.db, "workflow", `Workflow — ${plan.workflow_name}`, planToWire(plan), plan.steps.length);
  createWorkflowRun(room.db, workflowId, jobId, trigger, inputFileId);
  retireParkedJobs(room.db, workflowId);
  await submit(workflowQueueDeps(deps), jobId);
  return jobId;
}


export async function startWorkflowRun(
  deps: WorkflowRunDeps,
  workflowId: string,
  trigger: string,
  inputFileId: string | null,
  extraConsents: ReadonlySet<string>
): Promise<string> {
  assertWorkflowRunNotRollingBack(deps);
  const context = initialWorkflowRunContext(deps, workflowId);
  assertWorkflowInput(context.definition, inputFileId);
  const earlyRefusal = refusedWorkflowRun(context.room.db, workflowId, trigger);
  if (earlyRefusal !== null) {
    return earlyRefusal;
  }
  const plan = await workflowRunPlan(deps, workflowId, trigger, inputFileId, extraConsents, context);
  const room = currentWorkflowRunRoom(deps, context.roomPath);
  const lateRefusal = refusedWorkflowRun(room.db, workflowId, trigger);
  if (lateRefusal !== null) {
    return lateRefusal;
  }
  return enqueueWorkflowRun(deps, room, workflowId, trigger, inputFileId, plan);
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
