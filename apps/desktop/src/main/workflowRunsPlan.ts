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
import { queryOpt } from "./db-host/util.js";
import { type Lane, type RunOutcome, type Step } from "./jobs.js";
import { type EmitFn } from "./workflowCompose.js";
import { NEEDS_APPROVAL } from "./workflowEngine.js";
import { parseWorkflowDef, type WorkflowPlan } from "./workflowModel.js";


export const NO_ROOM_OPEN = "No room is open.";


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
export function argString(args: Record<string, unknown>, key: string): string | undefined {
  if (!hasOwn(args, key)) return undefined;
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}


/** `args["name_or_id"].or_else(args["name"])` — how nearly every agent-tool arm
 * names the workflow it means. */
export function argKey(args: Record<string, unknown>): string {
  return argString(args, "name_or_id") ?? argString(args, "name") ?? "";
}


/** `args["file"].or_else(args["file_id"])`. */
export function argFile(args: Record<string, unknown>): string | undefined {
  return argString(args, "file") ?? argString(args, "file_id");
}


/** Read an OWN property (any type) off a model-supplied args bag. */
export function argValue(args: Record<string, unknown>, key: string): unknown {
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
function wireStepRecord(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) {
    throw new Error("step is not an object");
  }
  return raw;
}


function wireStepDependencies(raw: Record<string, unknown>): unknown {
  if (hasOwn(raw, "dependsOn")) {
    return raw["dependsOn"];
  }
  if (hasOwn(raw, "depends_on")) {
    return raw["depends_on"];
  }
  return undefined;
}


function wireStepIdentity(raw: Record<string, unknown>): Pick<Step, "id" | "lane" | "kind"> {
  const id = raw["id"];
  const lane = raw["lane"];
  const kind = raw["kind"];
  if (typeof id !== "number" || !Number.isInteger(id)) {
    throw new Error("step.id");
  }
  if (typeof lane !== "string" || !KNOWN_LANES.has(lane)) {
    throw new Error("step.lane");
  }
  if (typeof kind !== "string") {
    throw new Error("step.kind");
  }
  return { id, lane: lane as Lane, kind };
}


function numericStepDependencies(deps: unknown): number[] {
  if (!Array.isArray(deps) || !deps.every((d) => typeof d === "number" && Number.isInteger(d))) {
    throw new Error("step.depends_on");
  }
  return deps as number[];
}


function stepFromWire(raw: unknown): Step {
  const record = wireStepRecord(raw);
  return {
    ...wireStepIdentity(record),
    params: record["params"],
    dependsOn: numericStepDependencies(wireStepDependencies(record)),
  };
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


function planRecord(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) {
    throw new Error("not an object");
  }
  return raw;
}


function requiredPlanString(plan: Record<string, unknown>, key: string): string {
  const value = plan[key];
  if (typeof value !== "string") {
    throw new Error(`missing ${key}`);
  }
  return value;
}


function optionalPlanString(plan: Record<string, unknown>, key: string): string | null {
  const value = plan[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`malformed ${key}`);
  }
  return value;
}


function workflowPlanSteps(plan: Record<string, unknown>): Step[] {
  const rawSteps = plan["steps"];
  if (!Array.isArray(rawSteps)) {
    throw new Error("malformed steps");
  }
  return rawSteps.map(stepFromWire);
}


/** A stored job row's `plan` back into a real {@link WorkflowPlan} —
 * `start_workflow_row`'s `serde_json::from_value::<WorkflowPlan>`. ANY
 * structural failure (a missing field, a step whose `depends_on` isn't an
 * array of integers, a `def` that fails `parseWorkflowDef`'s strict parse)
 * throws {@link WORKFLOW_PLAN_UNREADABLE}, exactly as Rust's
 * `.map_err(|_| …)` collapses every serde error into that one sentence. */
export function wireToPlan(raw: unknown): WorkflowPlan {
  try {
    const plan = planRecord(raw);
    return {
      workflow_id: requiredPlanString(plan, "workflow_id"),
      workflow_name: requiredPlanString(plan, "workflow_name"),
      trigger: requiredPlanString(plan, "trigger"),
      def: parseWorkflowDef(plan["def"]),
      resolved_model: requiredPlanString(plan, "resolved_model"),
      input_file_id: optionalPlanString(plan, "input_file_id"),
      prev_run_at: optionalPlanString(plan, "prev_run_at"),
      script_consents: consentsFromWire(plan["script_consents"]),
      steps: workflowPlanSteps(plan),
    };
  } catch {
    throw new Error(WORKFLOW_PLAN_UNREADABLE);
  }
}


/** `job.state.get("done")…unwrap_or_default()` — a resumed run's persisted
 * done-SET (never a scalar cursor; see {@link spawnWorkflowJob}'s checkpoint). */
function doneStateEntries(state: unknown): unknown[] {
  if (!isPlainObject(state)) {
    return [];
  }
  const done = state["done"];
  if (!Array.isArray(done)) {
    return [];
  }
  return done;
}


function isDoneStepIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}


export function doneSetFromState(state: unknown): Set<number> {
  const out = new Set<number>();
  for (const value of doneStateEntries(state)) {
    if (isDoneStepIndex(value)) {
      out.add(value);
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
