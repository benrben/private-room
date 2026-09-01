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
import { findSourceFileLike } from "./db-host/files.js";
import { getJob, getJobArtifact, type Job } from "./db-host/jobs.js";
import { findWorkflow, type Workflow } from "./db-host/workflows.js";
import { type RoomHandle } from "./jobs.js";
import { clampTestReport, parseBinding, testRunTrailer } from "./workflowCompose.js";
import { DEFAULT_WF_ARTIFACT, defUsesRunInput, parseWfArtifact, validateWithBinding, type WfArtifact, type WorkflowDef } from "./workflowModel.js";
import { type AgentTestWorkflowDeps, TEST_TIMEOUT_MS } from "./workflowRunsAgents.js";
import { argFile, argKey, NO_ROOM_OPEN } from "./workflowRunsPlan.js";
import { readableWorkflowDefinition, startWorkflowRun } from "./workflowRunsStart.js";


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
type WorkflowTestStatus = "done" | "error" | "paused" | "timeout";


interface WorkflowTestOutcome {
  status: WorkflowTestStatus;
  error: string | null;
}


interface WorkflowTestContext {
  room: RoomHandle;
  workflow: Workflow;
  definition: WorkflowDef;
}


function workflowTestContext(deps: AgentTestWorkflowDeps, args: Record<string, unknown>): WorkflowTestContext {
  const room = deps.rooms.current();
  if (room === null) {
    throw new Error(NO_ROOM_OPEN);
  }
  const workflow = findWorkflow(room.db, argKey(args));
  return { room, workflow, definition: readableWorkflowDefinition(workflow) };
}


function workflowValidationFailure(workflow: Workflow, definition: WorkflowDef): string | null {
  const validation = validateWithBinding(definition, parseBinding(workflow.binding));
  if (validation.ok) {
    return null;
  }
  return (
    `Test of "${workflow.name}": it doesn't validate yet, so it can't run. Fix these with update_workflow, then test again:\n` +
    `- ${validation.errors.join("\n- ")}`
  );
}


function assertWorkflowTestSlotIsFree(deps: AgentTestWorkflowDeps, workflow: Workflow): void {
  if (deps.state.runningJob !== null) {
    throw new Error(
      `Test of "${workflow.name}" did NOT run: another background job holds the single job slot. ` +
        "Its definition validates, but it has not been test-run. Do not call test_workflow " +
        "again this turn — the slot cannot free while you wait, so every retry returns this " +
        "same line. Tell the user it is saved and valid, and that they can test-run it once " +
        "the running job finishes."
    );
  }
}


function workflowTestInputFile(room: RoomHandle, args: Record<string, unknown>): string | null {
  const file = argFile(args);
  if (file === undefined) {
    return null;
  }
  return findSourceFileLike(room.db, file)[0] ?? null;
}


function assertWorkflowTestInput(workflow: Workflow, definition: WorkflowDef, fileId: string | null): void {
  if (defUsesRunInput(definition) && fileId === null) {
    throw new Error(
      `"${workflow.name}" runs on a chosen file — pass \`file\` (a file name) so the test has something to run on.`
    );
  }
}


async function startWorkflowTestRun(
  deps: AgentTestWorkflowDeps,
  workflow: Workflow,
  fileId: string | null
): Promise<string> {
  const jobId = await startWorkflowRun(deps, workflow.id, "agent", fileId, new Set());
  if (jobId === "") {
    throw new Error("Couldn't start a test run just now — try again in a moment.");
  }
  return jobId;
}


function realTestSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function workflowTestTiming(deps: AgentTestWorkflowDeps): { timeoutMs: number; sleep: (ms: number) => Promise<void> } {
  return { timeoutMs: deps.testTimeoutMs ?? TEST_TIMEOUT_MS, sleep: deps.sleepMs ?? realTestSleep };
}


function terminalWorkflowTestOutcome(job: Job): WorkflowTestOutcome | null {
  if (job.status === "done") {
    return { status: "done", error: null };
  }
  if (job.status === "error" || job.status === "paused") {
    return { status: job.status, error: whyOfJob(job) };
  }
  return null;
}


function currentWorkflowTestOutcome(deps: AgentTestWorkflowDeps, jobId: string): WorkflowTestOutcome | null {
  const room = deps.rooms.current();
  if (room === null) {
    return null;
  }
  const job = tryGetJob(room.db, jobId);
  return job === null ? null : terminalWorkflowTestOutcome(job);
}


async function stopAndReadWorkflowTest(
  deps: AgentTestWorkflowDeps,
  jobId: string,
  sleep: (ms: number) => Promise<void>
): Promise<WorkflowTestOutcome> {
  deps.cancelState.jobCancels.get(jobId)?.store(true);
  await sleep(1500);
  return currentWorkflowTestOutcome(deps, jobId) ?? { status: "timeout", error: null };
}


async function awaitWorkflowTestOutcome(
  deps: AgentTestWorkflowDeps,
  jobId: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<WorkflowTestOutcome> {
  const started = Date.now();
  for (;;) {
    const terminal = currentWorkflowTestOutcome(deps, jobId);
    if (terminal !== null) {
      return terminal;
    }
    if (Date.now() - started >= timeoutMs) {
      return stopAndReadWorkflowTest(deps, jobId, sleep);
    }
    await sleep(400);
  }
}


function workflowTestArtifact(deps: AgentTestWorkflowDeps, jobId: string, step: number): string | null {
  const room = deps.rooms.current();
  if (room === null) {
    return null;
  }
  try {
    return getJobArtifact(room.db, jobId, step);
  } catch {
    return null;
  }
}


function parsedWorkflowTestArtifact(raw: string): WfArtifact {
  try {
    return parseWfArtifact(JSON.parse(raw));
  } catch {
    return DEFAULT_WF_ARTIFACT;
  }
}


function workflowTestArtifactLabel(artifact: WfArtifact, position: number): string {
  return artifact.node_label ?? `Step ${position}`;
}


function workflowTestArtifactKind(artifact: WfArtifact): string {
  const kind = artifact.node_kind ?? "";
  return kind === "" ? "" : ` [${kind}]`;
}


function workflowTestArtifactState(artifact: WfArtifact): string {
  return artifact.skipped ? "skipped" : "done";
}


function workflowTestArtifactPreview(artifact: WfArtifact): string {
  const clipped = Array.from(artifact.result.trim()).slice(0, 240).join("");
  return clipped === "" ? "(no output)" : clipped.split("\n").join(" ");
}


function workflowTestStepLine(deps: AgentTestWorkflowDeps, jobId: string, step: number): string {
  const raw = workflowTestArtifact(deps, jobId, step);
  if (raw === null) {
    return `${step + 1}. (did not run)`;
  }
  const artifact = parsedWorkflowTestArtifact(raw);
  return `${step + 1}. ${workflowTestArtifactLabel(artifact, step + 1)}${workflowTestArtifactKind(artifact)} — ${workflowTestArtifactState(artifact)}: ${workflowTestArtifactPreview(artifact)}`;
}


function workflowTestStepLines(deps: AgentTestWorkflowDeps, jobId: string, total: number): string[] {
  const lines: string[] = [];
  for (let step = 0; step < total; step++) {
    lines.push(workflowTestStepLine(deps, jobId, step));
  }
  return lines;
}


function successfulWorkflowTestHeader(name: string): string {
  return `Test of "${name}": SUCCESS — every step ran.`;
}


function failedWorkflowTestHeader(name: string, error: string | null): string {
  return `Test of "${name}": FAILED — ${error ?? "a step errored (see steps below)"}`;
}


function pausedWorkflowTestHeader(name: string, error: string | null): string {
  if (error !== null) {
    return `Test of "${name}": PAUSED — ${error}`;
  }
  return `Test of "${name}": PAUSED — it was stopped before finishing. Nothing failed.`;
}


function timedOutWorkflowTestHeader(name: string, timeoutMs: number): string {
  return `Test of "${name}": still running after ${Math.round(timeoutMs / 1000)}s — stopped waiting (it may be a heavy model step). The partial results so far:`;
}


function workflowTestHeader(name: string, outcome: WorkflowTestOutcome, timeoutMs: number): string {
  if (outcome.status === "done") {
    return successfulWorkflowTestHeader(name);
  }
  if (outcome.status === "error") {
    return failedWorkflowTestHeader(name, outcome.error);
  }
  if (outcome.status === "paused") {
    return pausedWorkflowTestHeader(name, outcome.error);
  }
  return timedOutWorkflowTestHeader(name, timeoutMs);
}


function workflowTestReport(
  workflow: Workflow,
  outcome: WorkflowTestOutcome,
  timeoutMs: number,
  lines: string[]
): string {
  const header = workflowTestHeader(workflow.name, outcome, timeoutMs);
  const trailer = testRunTrailer(outcome.status);
  return clampTestReport(
    `${header}\nSteps:\n${lines.join("\n")}\n\n${trailer}\n\nThe workflow stays a DRAFT for the user to review and activate.`
  );
}


export async function agentTestWorkflow(
  deps: AgentTestWorkflowDeps,
  args: Record<string, unknown>
): Promise<string> {
  const context = workflowTestContext(deps, args);
  const validationFailure = workflowValidationFailure(context.workflow, context.definition);
  if (validationFailure !== null) {
    return validationFailure;
  }
  assertWorkflowTestSlotIsFree(deps, context.workflow);
  const fileId = workflowTestInputFile(context.room, args);
  assertWorkflowTestInput(context.workflow, context.definition, fileId);
  const jobId = await startWorkflowTestRun(deps, context.workflow, fileId);
  const timing = workflowTestTiming(deps);
  const outcome = await awaitWorkflowTestOutcome(deps, jobId, timing.timeoutMs, timing.sleep);
  const lines = workflowTestStepLines(deps, jobId, context.definition.nodes.length);
  return workflowTestReport(context.workflow, outcome, timing.timeoutMs, lines);
}
