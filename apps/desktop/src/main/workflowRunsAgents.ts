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
import { findSourceFileLike } from "./db-host/files.js";
import { createWorkflow as dbCreateWorkflow, findWorkflow, getSchedule, listWorkflows, setWorkflowStatus as dbSetWorkflowStatus, updateWorkflow as dbUpdateWorkflow, type Workflow } from "./db-host/workflows.js";
import { applySchedule, backfillNodeLabels, parseBinding, parseDef, scheduleFromArgs, validateWorkflowInner, type EmitFn, type ScheduleArg, type ValidateWorkflowInnerDeps } from "./workflowCompose.js";
import { type WorkflowDef } from "./workflowModel.js";
import { argFile, argKey, argString, argValue, emitWorkflowsChanged, NO_ROOM_OPEN } from "./workflowRunsPlan.js";
import { deleteWorkflowCmd } from "./workflowRunsCommands.js";
import { startWorkflowRun, type WorkflowRunDeps } from "./workflowRunsStart.js";


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


interface SavedWorkflowInput {
  name: string;
  definition: unknown;
  def: WorkflowDef;
  binding: ReturnType<typeof parseBinding>;
}


function saveWorkflowInput(args: Record<string, unknown>): SavedWorkflowInput {
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
  return { name, definition, def: parseDef(definition), binding: parseBinding(argValue(args, "binding")) };
}


function saveWorkflowText(args: Record<string, unknown>): { description: string; emoji: string } {
  return {
    description: (argString(args, "description") ?? "").trim(),
    emoji: (argString(args, "emoji") ?? "").trim(),
  };
}


async function assertWorkflowCanSave(
  db: Database.Database,
  def: WorkflowDef,
  binding: ReturnType<typeof parseBinding>,
  deps: ValidateWorkflowInnerDeps
): Promise<void> {
  const errs = await validateWorkflowInner(db, def, binding, deps);
  if (errs.length > 0) {
    // The corrective-error doctrine: hand the model the numbered list to fix.
    throw new Error(
      `The workflow is not valid yet — fix these and call save_workflow again:\n- ${errs.join("\n- ")}`
    );
  }
}


function applyOptionalWorkflowSchedule(
  db: Database.Database,
  workflowId: string,
  def: WorkflowDef,
  schedule: ScheduleArg | null
): void {
  if (schedule === null) {
    return;
  }
  applySchedule(db, workflowId, def, schedule.kind, schedule.param, schedule.enabled, schedule.catchUp);
}


/** Agent tool `save_workflow`: validate + compile, then write a DRAFT. */
export async function agentSaveWorkflow(
  db: Database.Database,
  args: Record<string, unknown>,
  createdBy: string,
  deps: ValidateWorkflowInnerDeps = {},
  emit?: EmitFn
): Promise<string> {
  const input = saveWorkflowInput(args);
  await assertWorkflowCanSave(db, input.def, input.binding, deps);
  const text = saveWorkflowText(args);
  const id = dbCreateWorkflow(
    db,
    input.name,
    text.description,
    text.emoji,
    input.definition,
    createdBy,
    input.binding
  );
  applyOptionalWorkflowSchedule(db, id, input.def, scheduleFromArgs(args));
  emitWorkflowsChanged(emit);
  return `Saved as a DRAFT named "${input.name}". Tell the user to review and activate it on the Workflows page.`;
}


interface UpdatedWorkflowInput {
  definition: unknown;
  def: WorkflowDef;
  bindingValue: unknown;
  binding: ReturnType<typeof parseBinding>;
}


function updatedWorkflowDefinition(args: Record<string, unknown>, current: Workflow): unknown {
  const definitionRaw = argValue(args, "definition");
  // `args.get("definition").cloned().unwrap_or_else(|| current.definition)` —
  // an explicitly NULL definition is Some(Null) in Rust and fails `parse_def`
  // by name, so `?? ` (which would silently fall back) is wrong here.
  return structuredClone(definitionRaw !== undefined ? definitionRaw : current.definition);
}


function updateWorkflowInput(args: Record<string, unknown>, current: Workflow): UpdatedWorkflowInput {
  const definition = updatedWorkflowDefinition(args, current);
  backfillNodeLabels(definition);
  const bindingRaw = argValue(args, "binding");
  const bindingValue = bindingRaw !== undefined ? bindingRaw : current.binding;
  return { definition, def: parseDef(definition), bindingValue, binding: parseBinding(bindingValue) };
}


async function assertWorkflowCanUpdate(
  db: Database.Database,
  input: UpdatedWorkflowInput,
  deps: ValidateWorkflowInnerDeps
): Promise<void> {
  const errs = await validateWorkflowInner(db, input.def, input.binding, deps);
  if (errs.length > 0) {
    throw new Error(`The updated workflow is not valid — fix these and try again:\n- ${errs.join("\n- ")}`);
  }
}


function updatedWorkflowText(args: Record<string, unknown>, current: Workflow): {
  name: string;
  description: string;
  emoji: string;
} {
  return {
    name: (argString(args, "name") ?? current.name).trim(),
    description: (argString(args, "description") ?? current.description).trim(),
    emoji: (argString(args, "emoji") ?? current.emoji).trim(),
  };
}


function updateWorkflowRow(
  db: Database.Database,
  current: Workflow,
  args: Record<string, unknown>,
  input: UpdatedWorkflowInput
): void {
  const text = updatedWorkflowText(args, current);
  dbUpdateWorkflow(
    db,
    current.id,
    text.name,
    text.description,
    text.emoji,
    input.definition,
    input.bindingValue
  );
}


function returnWorkflowToDraft(db: Database.Database, workflow: Workflow): void {
  if (workflow.status === "active") {
    dbSetWorkflowStatus(db, workflow.id, "draft");
  }
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
  const input = updateWorkflowInput(args, current);
  await assertWorkflowCanUpdate(db, input, deps);
  updateWorkflowRow(db, current, args, input);
  returnWorkflowToDraft(db, current);
  applyOptionalWorkflowSchedule(db, current.id, input.def, scheduleFromArgs(args));
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
export const TEST_TIMEOUT_MS = 240_000;


/** Deps {@link agentTestWorkflow} needs beyond {@link WorkflowRunDeps} — the
 * poll cadence, injectable so a test is fast and deterministic. */
export interface AgentTestWorkflowDeps extends WorkflowRunDeps {
  /** Defaults to {@link TEST_TIMEOUT_MS}. */
  testTimeoutMs?: number;
  /** Defaults to a real `setTimeout`-backed sleep. */
  sleepMs?: (ms: number) => Promise<void>;
}
