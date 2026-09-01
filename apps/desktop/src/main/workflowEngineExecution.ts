/** Cohesive extraction from workflowEngineDispatch.ts; the facade preserves its public API. */
/** Cohesive extraction from workflowEngine.ts; the facade preserves its public API. */
/**
 * The LLM-graph workflow engine's PER-NODE EXECUTOR. Ported from
 * `src-tauri/src/commands/jobs/workflow.rs` LINES 1031-2544 (the file is 5855
 * lines): everything from the `---- executor ----` banner through the end of
 * `save_file_node`, stopping right before `park_outcome` (line 2544 — a later
 * batch's territory: the run-outcome Stop-vs-error classification that sits
 * ABOVE this file's own node-level funnel).
 *
 * `workflowModel.ts` already ports lines 1-1030 (the data model, validator and
 * compiler); THIS file builds directly on top of it — `WorkflowNode`/
 * `NodeKind`/`WorkflowPlan`/`WfArtifact`/`FileSelector` and their parsers are
 * imported, never redeclared.
 *
 * ============================================================================
 * WHAT IS A THIN SIDECAR PROXY HERE, AND WHAT IS NOT
 * ============================================================================
 * Per the Rust source's own "MIGRATION slice 1/2/3" comments (2026-07-25,
 * "Rust drives, Python thinks"): the `extract`/`route`/`vote`/`refine`/
 * `plan_and_map` node kinds run ENTIRELY in the Python sidecar behind
 * `/wf_node`. The aggregation logic that used to live in Rust
 * (`aggregate_votes`, `build_extract_schema`, `route_schema_of`,
 * `pick_route_label`) was DELETED there and is NOT reimplemented here: each
 * arm below builds the payload, POSTs it, and unwraps the JSON result — just
 * as Rust's own `wf_node`/`wf_node_value` do. Only `route`'s `branch` is read
 * out separately, because `compileWorkflow` prunes dead edges off it and the
 * executor has to know which one was taken.
 *
 * `summarize_file`'s per-file one-liner is the SAME shape of thin proxy and is
 * ported as one ({@link summarizeOneFileViaSidecar}) rather than stubbed:
 * `commands/summarize.rs::summarize_one_file` is literally a POST to
 * `/summarize_file` plus `v["summary"]`, and `commands/jobs.rs::classify_liner`
 * is a pure sentinel decision whose four outcomes this file's `summarize_file`
 * arm matches on IN RANGE. Refusing a dependency that is one already-existing
 * endpoint away would be dishonest in the other direction.
 *
 * ============================================================================
 * RESERVED KEYS — read before touching {@link buildWfNodePayload}
 * ============================================================================
 * `wf_node_value`'s payload merges a node's own body fields UNDER
 * `kind`/`model`/`base_url`/`keep_alive`/`run_id`/`parallel`, which must never
 * be shadowed: the sidecar keys its PRIVACY DOOR and the Keychain-backed
 * provider credentials off `body["model"]` specifically, so a body field named
 * `model` winning would silently send a protected room's text to whatever
 * engine that field named. The merge is built on an `Object.create(null)` base
 * and skips any body key naming a reserved slot — never a blind
 * `payload[k] = v` loop (rule 2: a `"__proto__"`-named entry polluting
 * `Object.prototype` has been a real bug in this codebase four times already;
 * on a null-prototype object an own `"__proto__"` key is an ordinary data
 * property, not the exotic accessor). Rust additionally `debug_assert!`s the
 * collision — a dev-build-only panic for visibility; this port always drops
 * silently, matching Rust's RELEASE behavior, which is unconditional either
 * way.
 *
 * ============================================================================
 * INTERPOLATION ORDER — a real security property, not a style choice
 * ============================================================================
 * {@link interpolate} substitutes `{{input}}` LAST. `{{input}}` carries model
 * output and file text, so substituting it FIRST would let upstream text that
 * happens to contain the literal string `{{files}}` be expanded as if the
 * workflow AUTHOR had written that placeholder — leaking the room's whole file
 * inventory into a downstream prompt. Pinned by this file's own
 * `upstream_text_cannot_conjure_a_template_placeholder` test.
 *
 * Every substitution here (and in {@link applyTransform}'s `replace`) is done
 * with `split().join()`, NOT `String.replaceAll`: `replaceAll` interprets `$&`,
 * `` $` ``, `$'` and `$1` IN THE REPLACEMENT as substitution patterns, and the
 * replacement here is model output. Rust's `str::replace` is literal, so this
 * one must be too.
 *
 * ============================================================================
 * FILE SELECTORS — the previously-fixed feedback-loop bug
 * ============================================================================
 * `newest`/`all`/`name_like`/`missing_summary` INCLUDE AI-generated files (a
 * room whose useful content IS AI-authored must still be readable by these —
 * excluding `source='generated'` there once matched nothing, so every
 * file-read node returned "No file matched"); `since_last_run` EXCLUDES them,
 * because that selector drives SCHEDULED re-runs and including a workflow's
 * own just-saved output there would feed it back into itself forever. The
 * split is preserved exactly, selector by selector, in {@link resolveFiles}.
 *
 * ============================================================================
 * WHAT IS INJECTED, NEVER FAKED
 * ============================================================================
 * - {@link AgentRunFn} (`agent_run`) — `run_agent_headless` (workflow.rs:2429,
 *   past this file's range) needs concrete room/tool/engine state with no
 *   Electron port anywhere in this migration. Injected exactly as Rust's own
 *   `AgentRunFn` is, defaulting to {@link agentRunNotImplemented}: a labeled
 *   rejection, never a fabricated answer (`jobs.ts`'s
 *   `renderPodcastAudioNotImplemented` / `filePass.ts`'s
 *   `resolvePassEngineNotImplemented` convention).
 * - `emit_workflow_node`'s live pipeline-diagram event has no Electron
 *   renderer bridge yet (Phase 2, gated on owner go-ahead). Ported as an
 *   OPTIONAL injected {@link EmitFn} defaulting to nothing — `recIpc.ts`/
 *   `dictStopTimeout.ts`/`filePass.ts`'s established pattern — never a
 *   simulated `window.emit`.
 * - `file_pass`'s engine resolution is threaded straight through to
 *   `filePass.ts`'s own already-documented `ResolvePassEngine` seam; this file
 *   invents no second copy of that gap.
 * - Every OTHER dependency reaches its REAL already-ported implementation:
 *   `script_run` → `scriptRun.ts`'s `resolveScriptFile`/`runScriptProcess`,
 *   `http_fetch` → `webFetch.ts`'s SSRF-guarded `fetchPage`, `file_pass` →
 *   `filePass.ts`'s `driveFilePass`, `transform`'s `strip_html` →
 *   `editMatchHtml.ts`'s `stripHtml`, and the sidecar transports →
 *   `sidecarJsonCancellable.ts`. Each is overridable for tests, but none is
 *   stubbed by default.
 *
 * ============================================================================
 * STOP VS. ERROR (rule 4)
 * ============================================================================
 * Every cancellable path here (a bare `cancel.load()` check, a sidecar call's
 * own `stopped` outcome, `driveFilePass`'s own `"STOPPED"` throw) surfaces the
 * literal string `"STOPPED"`, exactly as Rust's `Err("STOPPED".into())` does,
 * and a `script_run` that parked for approval is marked {@link NEEDS_APPROVAL}.
 * {@link executeWorkflowStep} — the single funnel, mirroring Rust's own
 * "the badge is decided HERE and nowhere else" invariant — carries BOTH
 * sentinels through UNCHANGED in the `StepResult` it returns, stripping the
 * park marker only from what the diagram shows. Classifying them into a real
 * Paused-vs-Error run outcome is `park_outcome`'s job, one line past this
 * file's range, and is deliberately NOT reimplemented here.
 *
 * ============================================================================
 * DEVIATIONS
 * ============================================================================
 * - {@link executeWorkflowStep} returns a `StepResult` value rather than
 *   throwing, mirroring Rust's `Result<(), String>` — `jobs.ts`'s own
 *   documented reason: a wave run through `Promise.all` must not have one
 *   step's rejection abandon its siblings as unhandled-rejection noise (see
 *   `run_plan_discards_a_failed_waves_completed_siblings`). Internally every
 *   helper throws, and only that outermost boundary converts, exactly as
 *   `filePass.ts`'s `executePassStep` already does.
 * - No `tauri::AppHandle<R>`/`AppState`: every room-pinned function takes
 *   `jobs.ts`'s established `RoomSource` + `pinnedDb` seam.
 * - `NodeReport` is a discriminated union rather than Rust's tuple-like enum
 *   (`StepResult`, `ValidationResult`, … — this port's standing convention).
 */
import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag, stopped } from "./cancel.js";
import { pinnedDb, type Step, type StepResult } from "./jobs.js";
import { humanizeEmptyGeneration, sidecarJsonCancellable } from "./sidecarJsonCancellable.js";
import { type PublishedRef } from "./filePass.js";
import { DEFAULT_WF_ARTIFACT, nodeKindTag, type WfArtifact, type WorkflowNode, type WorkflowPlan } from "./workflowModel.js";
import { agentRunNotImplemented, applyTransform, NEEDS_APPROVAL, wfGenerate, type WorkflowStepDeps } from "./workflowEngineGeneration.js";
import { type NodeReport, runFilePassNode, runScriptNode, summarizeFileNode } from "./workflowEngineSteps.js";
import { countNewFiles, edgeIsLive, emitWorkflowNode, evalCondition, interpolate, loadWfArtifact, ROOM_GONE, storeWfArtifact } from "./workflowEngineInputs.js";
import { parsedStepNode, saveFileNodeHybrid } from "./workflowEngineSave.js";
import { runWorkflowNode } from "./workflowEngineRouting.js";



function emitWorkflowReport(
  deps: WorkflowStepDeps,
  jobId: string,
  workflowId: string,
  node: WorkflowNode,
  report: NodeReport,
): void {
  if (report.kind === "skipped") {
    emitWorkflowNode(deps.emit, jobId, workflowId, node.id, "skipped", null);
    return;
  }
  emitWorkflowNode(deps.emit, jobId, workflowId, node.id, "done", report.result === "" ? null : report.result);
}



function failedWorkflowStep(
  deps: WorkflowStepDeps,
  jobId: string,
  workflowId: string,
  node: WorkflowNode,
  error: unknown,
): StepResult {
  const raw = error instanceof Error ? error.message : String(error);
  const message = humanizeEmptyGeneration(raw) ?? raw;
  const shown = message.startsWith(NEEDS_APPROVAL) ? message.slice(NEEDS_APPROVAL.length) : message;
  emitWorkflowNode(deps.emit, jobId, workflowId, node.id, "error", shown);
  return { ok: false, error: message };
}



async function executedWorkflowStep(
  deps: WorkflowStepDeps,
  jobId: string,
  roomPath: string,
  plan: WorkflowPlan,
  step: Step,
  cancel: CancelFlag,
  published: PublishedRef,
  node: WorkflowNode,
): Promise<StepResult> {
  try {
    const report = await runWorkflowNode(deps, jobId, roomPath, plan, step, cancel, published, node);
    emitWorkflowReport(deps, jobId, plan.workflow_id, node, report);
    return { ok: true };
  } catch (error) {
    return failedWorkflowStep(deps, jobId, plan.workflow_id, node, error);
  }
}



export async function executeWorkflowStep(
  deps: WorkflowStepDeps,
  jobId: string,
  roomPath: string,
  plan: WorkflowPlan,
  step: Step,
  cancel: CancelFlag,
  published: PublishedRef
): Promise<StepResult> {
  const node = parsedStepNode(step);
  if (node === null) return { ok: false, error: "this workflow step is unreadable" };
  emitWorkflowNode(deps.emit, jobId, plan.workflow_id, node.id, "running", null);
  return executedWorkflowStep(deps, jobId, roomPath, plan, step, cancel, published, node);
}



export type WorkflowNodeRunContext = {
  deps: WorkflowStepDeps;
  jobId: string;
  roomPath: string;
  plan: WorkflowPlan;
  step: Step;
  cancel: CancelFlag;
  published: PublishedRef;
  modelChoice: string | null;
  inputsJoined: string;
  liveInputs: string[];
  existing: WfArtifact | null;
};



type LiveWorkflowInputs = {
  inputs: string[];
  livePresent: boolean;
};



function liveWorkflowInputs(
  db: Database.Database,
  jobId: string,
  incoming: Array<{ parent: number; branch: string | null }>
): LiveWorkflowInputs {
  const inputs: string[] = [];
  let livePresent = false;
  for (const { parent, branch } of incoming) {
    const artifact = loadWfArtifact(db, jobId, parent);
    if (edgeIsLive(artifact, branch)) {
      livePresent = true;
      if (artifact !== null && artifact.result.trim() !== "") {
        inputs.push(artifact.result);
      }
    }
  }
  return { inputs, livePresent };
}



export function readLiveWorkflowInputs(
  deps: WorkflowStepDeps,
  roomPath: string,
  jobId: string,
  incoming: Array<{ parent: number; branch: string | null }>
): LiveWorkflowInputs {
  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) {
    throw new Error(ROOM_GONE);
  }
  return liveWorkflowInputs(db, jobId, incoming);
}



export function skipDeadWorkflowNode(
  deps: WorkflowStepDeps,
  roomPath: string,
  jobId: string,
  step: Step,
  node: WorkflowNode,
  incoming: Array<{ parent: number; branch: string | null }>,
  livePresent: boolean
): NodeReport | null {
  if (incoming.length === 0 || livePresent) {
    return null;
  }
  const db = pinnedDb(deps.rooms, roomPath);
  if (db !== null) {
    storeWfArtifact(db, jobId, step.id, {
      ...DEFAULT_WF_ARTIFACT,
      skipped: true,
      node_label: node.label,
      node_kind: nodeKindTag(node),
    });
  }
  return { kind: "skipped" };
}



export function priorWorkflowArtifact(deps: WorkflowStepDeps, roomPath: string, jobId: string, stepId: number): WfArtifact | null {
  const db = pinnedDb(deps.rooms, roomPath);
  return db === null ? null : loadWfArtifact(db, jobId, stepId);
}



export function storeCompletedWorkflowNode(
  deps: WorkflowStepDeps,
  roomPath: string,
  jobId: string,
  stepId: number,
  node: WorkflowNode,
  artifact: WfArtifact
): NodeReport {
  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) {
    throw new Error(ROOM_GONE);
  }
  const completed = { ...artifact, node_label: node.label, node_kind: nodeKindTag(node) };
  storeWfArtifact(db, jobId, stepId, completed);
  return { kind: "done", result: completed.result };
}



export async function runGenerateWorkflowNode(context: WorkflowNodeRunContext, node: Extract<WorkflowNode, { kind: "generate" }>): Promise<WfArtifact> {
  const prompt = interpolate(context.deps.rooms, context.roomPath, node.prompt, context.inputsJoined);
  const model = context.modelChoice ?? context.plan.resolved_model;
  const text = await wfGenerate(context.deps.post ?? sidecarJsonCancellable, model, prompt, undefined, context.cancel);
  return { ...DEFAULT_WF_ARTIFACT, result: text };
}



export function runSummarizeFileWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "summarize_file" }>
): Promise<WfArtifact> {
  return summarizeFileNode(context.deps, context.roomPath, context.plan, node.select, context.modelChoice, context.cancel);
}



export async function runFilePassWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "file_pass" }>
): Promise<WfArtifact> {
  if (context.existing !== null && context.existing.file_id !== null && !context.existing.skipped) {
    return { ...DEFAULT_WF_ARTIFACT, result: context.existing.result, file_id: context.existing.file_id };
  }
  return runFilePassNode(
    context.deps,
    context.jobId,
    context.roomPath,
    context.plan,
    node.select,
    node.instruction,
    node.mode,
    context.cancel,
    context.published
  );
}



export async function runAgentWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "agent_run" }>
): Promise<WfArtifact> {
  const question = interpolate(context.deps.rooms, context.roomPath, node.question, context.inputsJoined);
  const agentRun = context.deps.agentRun ?? agentRunNotImplemented;
  return { ...DEFAULT_WF_ARTIFACT, result: await agentRun(question, context.cancel, context.roomPath) };
}



export async function runSaveFileWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "save_file" }>
): Promise<WfArtifact> {
  if (stopped(context.cancel)) {
    throw new Error("STOPPED");
  }
  const { result, fileId } = await saveFileNodeHybrid(
    context.deps.rooms,
    context.roomPath,
    node.name_template,
    node.format,
    node.mode,
    context.inputsJoined,
    context.existing,
    context.published,
    `Workflow saved — ${context.plan.workflow_name}`,
    context.deps.notifyFilesChanged
  );
  return { ...DEFAULT_WF_ARTIFACT, result, file_id: fileId };
}



export function runConditionWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "condition" }>
): WfArtifact {
  const newFiles = node.op === "new_files_since_last_run" ? countNewFiles(context.deps.rooms, context.roomPath, context.plan.prev_run_at) : 0;
  const taken = evalCondition(node.op, context.inputsJoined, node.value, newFiles);
  const branch = taken ? "then" : "else";
  return { ...DEFAULT_WF_ARTIFACT, result: `branch: ${branch}`, branch };
}



export async function runScriptWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "script_run" }>
): Promise<WfArtifact> {
  if (context.existing !== null && !context.existing.skipped) {
    return { ...DEFAULT_WF_ARTIFACT, result: context.existing.result, file_id: context.existing.file_id };
  }
  const stdin = node.mode === "transform" ? context.inputsJoined : null;
  return runScriptNode(
    context.deps,
    context.jobId,
    context.step.id,
    context.roomPath,
    context.plan,
    node.file,
    node.mode,
    stdin,
    context.cancel,
    context.published
  );
}



export function runTransformWorkflowNode(
  context: WorkflowNodeRunContext,
  node: Extract<WorkflowNode, { kind: "transform" }>
): WfArtifact {
  return { ...DEFAULT_WF_ARTIFACT, result: applyTransform(node.op, node.find, node.value, context.inputsJoined) };
}
