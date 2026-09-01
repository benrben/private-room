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
import { type CancelState } from "./cancel.js";
import { getFileExtractedText } from "./db-host/files.js";
import { type Job } from "./db-host/jobs.js";
import { queryOpt } from "./db-host/util.js";
import { deleteWorkflow as dbDeleteWorkflow, getWorkflow, listWorkflowRuns, setWorkflowPinned as dbSetWorkflowPinned, setWorkflowStatus as dbSetWorkflowStatus, type Workflow, type WorkflowRun } from "./db-host/workflows.js";
import { type RoomHandle } from "./jobs.js";
import { interpreterLine, readScriptApprovals } from "./scriptConsent.js";
import { parseScriptManifest, resolveInterpreter, resolveScriptFile, scriptFingerprint, scriptLangOf, type ResolvedScriptFile } from "./scriptRun.js";
import { applySchedule, parseBinding, parseDef, type ScheduleArg } from "./workflowCompose.js";
import { parseWorkflowDef, validateRunnable, type WorkflowDef } from "./workflowModel.js";
import { DEFINITION_UNREADABLE, type ScriptApprovalRequest, startWorkflowRun, type WorkflowRunDeps } from "./workflowRunsStart.js";
import { NO_ROOM_OPEN } from "./workflowRunsPlan.js";
import { deleteJobBestEffort, jobForWorkflowRun } from "./workflowRunsJob.js";


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
function resolvedWorkflowScript(
  db: Database.Database,
  node: WorkflowDef["nodes"][number]
): ResolvedScriptFile | null {
  if (node.kind !== "script_run") {
    return null;
  }
  try {
    return resolveScriptFile(db, node.file);
  } catch {
    return null;
  }
}


function pendingScriptApproval(
  resolved: ResolvedScriptFile,
  approved: ReadonlySet<string>,
  seen: Set<string>
): ScriptApprovalRequest | null {
  if (scriptLangOf(resolved.name) === null) {
    return null;
  }
  const sha = scriptFingerprint(resolved.bytes);
  if (approved.has(sha) || seen.has(sha)) {
    return null;
  }
  seen.add(sha);
  const manifest = parseScriptManifest(resolved.name, resolved.bytes.toString("utf8"));
  const runner = resolveInterpreter(manifest);
  return {
    fileId: resolved.id,
    name: resolved.name,
    sha,
    interpreterLine: interpreterLine(runner, resolved.name),
  };
}


function neededScriptApprovals(
  db: Database.Database,
  userDataDir: string,
  def: WorkflowDef
): ScriptApprovalRequest[] {
  const approved = new Set<string>(readScriptApprovals(userDataDir));
  const needsPrompt: ScriptApprovalRequest[] = [];
  const seen = new Set<string>();
  for (const node of def.nodes) {
    const resolved = resolvedWorkflowScript(db, node);
    if (resolved === null) {
      continue;
    }
    const request = pendingScriptApproval(resolved, approved, seen);
    if (request !== null) {
      needsPrompt.push(request);
    }
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
function assertFileInCurrentRoom(db: Database.Database, fileId: string | null): void {
  if (fileId !== null && !fileExistsInRoom(db, fileId)) {
    throw new Error("That file is no longer in this room.");
  }
}


function manualWorkflowDefinition(workflow: Workflow): WorkflowDef {
  try {
    return parseWorkflowDef(workflow.definition);
  } catch {
    throw new Error(DEFINITION_UNREADABLE);
  }
}


interface ManualWorkflowRunContext {
  room: RoomHandle;
  definition: WorkflowDef;
}


function manualWorkflowRunContext(
  deps: RunWorkflowCommandDeps,
  workflowId: string,
  fileId: string | null
): ManualWorkflowRunContext {
  const room = deps.rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  assertFileInCurrentRoom(room.db, fileId);
  return { room, definition: manualWorkflowDefinition(getWorkflow(room.db, workflowId)) };
}


async function approvedWorkflowRunScripts(
  deps: RunWorkflowCommandDeps,
  db: Database.Database,
  definition: WorkflowDef
): Promise<Set<string>> {
  const needsPrompt = neededScriptApprovals(db, deps.userDataDir, definition);
  const grants = new Set<string>();
  if (needsPrompt.length === 0) {
    return grants;
  }
  const approve = deps.scriptRunApproved;
  if (approve === undefined) {
    throw new Error(SCRIPT_APPROVAL_UI_NOT_IMPLEMENTED);
  }
  for (const request of needsPrompt) {
    if (!(await approve(request))) {
      throw new Error(`The script “${request.name}” wasn't approved, so this workflow can't run.`);
    }
    grants.add(request.sha);
  }
  return grants;
}


export async function runWorkflowCommand(
  deps: RunWorkflowCommandDeps,
  workflowId: string,
  fileId: string | null
): Promise<string> {
  const context = manualWorkflowRunContext(deps, workflowId, fileId);
  const grants = await approvedWorkflowRunScripts(deps, context.room.db, context.definition);
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
function isUnfinishedWorkflowJob(job: Job): boolean {
  return job.status === "running" || job.status === "queued" || job.status === "paused";
}


function deleteUnfinishedWorkflowRun(
  db: Database.Database,
  run: WorkflowRun,
  cancelState: CancelState | undefined
): void {
  const job = jobForWorkflowRun(db, run);
  if (job === null || !isUnfinishedWorkflowJob(job) || run.jobId === null) {
    return;
  }
  cancelState?.jobCancels.get(run.jobId)?.store(true);
  deleteJobBestEffort(db, run.jobId);
}


export function deleteWorkflowCmd(
  db: Database.Database,
  id: string,
  cancelState?: CancelState
): void {
  for (const run of listWorkflowRuns(db, id)) {
    deleteUnfinishedWorkflowRun(db, run, cancelState);
  }
  dbDeleteWorkflow(db, id);
}
