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
import { CancelFlag } from "./cancel.js";
import { pinnedDb, type RoomSource, type Step } from "./jobs.js";
import { getFileExtractedText, inTransaction, setFileAiSummary, updateFileContent } from "./db-host/files.js";
import { snapshotFileVersion } from "./db-host/versions.js";
import { sidecarJsonCancellable } from "./sidecarJsonCancellable.js";
import { resolveScriptFile, runScriptProcess, scriptFingerprint, type ScriptRunDeps, type ScriptRunReport } from "./scriptRun.js";
import { driveFilePass, type DriveFilePassDeps, type PublishedRef, type SidecarPostFn } from "./filePass.js";
import { DEFAULT_WF_ARTIFACT, type FileSelector, type WfArtifact, type WorkflowPlan } from "./workflowModel.js";
import { asRecord, interpolate, resolveFiles, ROOM_GONE } from "./workflowEngineInputs.js";
import { type LinerOutcome, NEEDS_APPROVAL, type SummarizeOneFileFn, summarizeOneFileViaSidecar, summarizeOneLiner, wfGenerate, type WorkflowStepDeps } from "./workflowEngineGeneration.js";


/** How one step ended, for the pipeline diagram. Ported from `NodeReport`
 * (`Skipped | Done(String)`). */
export type NodeReport = { readonly kind: "skipped" } | { readonly kind: "done"; readonly result: string };


// ============================================================================
// step.params reading (loose — this is the app's OWN state)
// ============================================================================

export function stepParamsRecord(step: Step): Record<string, unknown> {
  return asRecord(step.params) ?? {};
}


export function stepModel(params: Record<string, unknown>): string | null {
  return typeof params.model === "string" ? params.model : null;
}


type IncomingStep = { parent: number; branch: string | null };


function incomingParent(record: Record<string, unknown>): number | null {
  const parent = record.parent;
  return typeof parent === "number" && Number.isInteger(parent) && parent >= 0 ? parent : null;
}


function incomingStep(value: unknown): IncomingStep | null {
  const record = asRecord(value);
  if (record === null) return null;
  const parent = incomingParent(record);
  if (parent === null) return null;
  return { parent, branch: typeof record.branch === "string" ? record.branch : null };
}


/** `i["parent"].as_u64()` — a non-integer or negative parent is skipped, the
 * same way `as_u64()` returns `None` for one. */
export function stepIncoming(params: Record<string, unknown>): IncomingStep[] {
  const raw = params.incoming;
  if (!Array.isArray(raw)) return [];
  const out: IncomingStep[] = [];
  for (const item of raw) {
    const incoming = incomingStep(item);
    if (incoming !== null) out.push(incoming);
  }
  return out;
}


// ============================================================================
// run_file_pass_node / run_script_node (workflow.rs:2109-2264)
// ============================================================================

/** Ported from `run_file_pass_node`. */
export async function runFilePassNode(
  deps: WorkflowStepDeps,
  jobId: string,
  roomPath: string,
  plan: WorkflowPlan,
  select: FileSelector,
  instruction: string,
  mode: string,
  cancel: CancelFlag,
  published: PublishedRef
): Promise<WfArtifact> {
  const files = resolveFiles(deps.rooms, roomPath, select, plan.input_file_id, plan.prev_run_at);
  // A full-file pass reads ONE file end to end. `all` is rejected at
  // validation for this node kind, but a narrowing selector can still match
  // several — name the one that was read and how many were left, rather than
  // dropping the rest in silence.
  const matched = files.length;
  const first = files[0];
  if (first === undefined) {
    return { ...DEFAULT_WF_ARTIFACT, result: "No file matched — nothing to read." };
  }
  const [id, name] = first;
  const driveDeps: DriveFilePassDeps = {
    rooms: deps.rooms,
    emit: deps.emit,
    post: deps.post,
    resolveEngine: deps.resolveEngine,
  };
  const { message, meta } = await driveFilePass(driveDeps, jobId, roomPath, id, name, instruction, mode, cancel);
  const fileId = meta?.id ?? null;
  if (meta !== null) {
    published.value = meta;
  }
  const result =
    matched > 1
      ? `${message}\n\nRead "${name}" only — ${matched - 1} other matching file(s) were not read. ` +
        `A full-file pass covers one file; use a "for each file" step to cover them all.`
      : message;
  return { ...DEFAULT_WF_ARTIFACT, result, file_id: fileId };
}


/**
 * Wave 5 (Idea 13): the `script_run` node arm. Resolves the script file id,
 * reads its consent hash from the IMMUTABLE plan snapshot (a mid-run script
 * edit parks, never silently runs new code), runs it, records the report JSON
 * as the step artifact, and publishes the first imported output. Ported from
 * `run_script_node`.
 */
type ResolvedScriptFile = ReturnType<typeof resolveScriptFile>;


function matchingScriptConsent(plan: WorkflowPlan, resolved: ResolvedScriptFile): string {
  const direct = plan.script_consents.get(resolved.id);
  if (direct !== undefined) return direct;
  const fingerprint = scriptFingerprint(resolved.bytes);
  for (const consent of plan.script_consents.values()) {
    if (consent === fingerprint) return consent;
  }
  return "";
}


function workflowScriptDeps(deps: WorkflowStepDeps): ScriptRunDeps {
  return {
    rooms: deps.rooms,
    cacheDir: deps.cacheDir,
    notifyFilesChanged: deps.notifyFilesChanged,
    execute: deps.scriptExecute,
  };
}


function rethrowScriptRunError(resolved: ResolvedScriptFile, consentHash: string, error: unknown): never {
  if (scriptFingerprint(resolved.bytes) !== consentHash) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${NEEDS_APPROVAL}${message}`);
  }
  throw error;
}


async function approvedScriptReport(
  deps: WorkflowStepDeps,
  jobId: string,
  stepId: number,
  roomPath: string,
  resolved: ResolvedScriptFile,
  consentHash: string,
  stdin: string | null,
  cancel: CancelFlag,
): Promise<ScriptRunReport> {
  try {
    return await runScriptProcess(
      workflowScriptDeps(deps), jobId, stepId, roomPath, resolved.id, consentHash, stdin, cancel
    );
  } catch (error) {
    return rethrowScriptRunError(resolved, consentHash, error);
  }
}


function scriptArtifactResult(report: ScriptRunReport, mode: string): string {
  const imported = report.imported.length;
  if (mode === "transform") {
    const output = report.stdoutTail.trim();
    return output === "" ? `(the script produced no output; ${imported} file(s) imported)` : output;
  }
  return JSON.stringify(report);
}


function publishScriptOutput(report: ScriptRunReport, published: PublishedRef): string | null {
  const first = report.imported[0] ?? null;
  if (first !== null) published.value = first;
  return first?.id ?? null;
}


export async function runScriptNode(
  deps: WorkflowStepDeps,
  jobId: string,
  stepId: number,
  roomPath: string,
  plan: WorkflowPlan,
  file: string,
  mode: string,
  stdin: string | null,
  cancel: CancelFlag,
  published: PublishedRef
): Promise<WfArtifact> {
  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) {
    throw new Error(ROOM_GONE);
  }
  // Resolve the node's `file` (a stored file id, or a name) through the ONE
  // resolver the consent stamping and the consent card also use.
  const resolved = resolveScriptFile(db, file);
  const consentHash = matchingScriptConsent(plan, resolved);
  const report = await approvedScriptReport(deps, jobId, stepId, roomPath, resolved, consentHash, stdin, cancel);
  return {
    ...DEFAULT_WF_ARTIFACT,
    result: scriptArtifactResult(report, mode),
    file_id: publishScriptOutput(report, published),
  };
}


// ============================================================================
// summarize_file / for_each_file node bodies
// ============================================================================

function throwIfCancelled(cancel: CancelFlag): void {
  if (cancel.load()) {
    throw new Error("STOPPED");
  }
}


function summarySourceText(rooms: RoomSource, roomPath: string, id: string): string | null {
  const db = pinnedDb(rooms, roomPath);
  return db === null ? null : getFileExtractedText(db, id);
}


function cacheSummary(rooms: RoomSource, roomPath: string, id: string, summary: string): void {
  const db = pinnedDb(rooms, roomPath);
  if (db !== null) {
    setFileAiSummary(db, id, summary);
  }
}


function cachedSummaryLine(rooms: RoomSource, roomPath: string, id: string, name: string, liner: string): string {
  cacheSummary(rooms, roomPath, id, liner);
  return `${name}: ${liner}`;
}


function stuckSummaryLine(rooms: RoomSource, roomPath: string, id: string, name: string): string {
  cacheSummary(rooms, roomPath, id, "");
  return `${name}: (no description could be written)`;
}


function summarizeOutcomeLine(
  rooms: RoomSource,
  roomPath: string,
  id: string,
  name: string,
  outcome: LinerOutcome
): string {
  switch (outcome.kind) {
    case "cached":
      return cachedSummaryLine(rooms, roomPath, id, name, outcome.liner);
    case "stuck":
      return stuckSummaryLine(rooms, roomPath, id, name);
    case "failed":
      return `${name}: (not described this run — trying again next time)`;
    case "hard":
      throw new Error(outcome.error);
  }
}


function summaryModel(modelChoice: string | null, plan: WorkflowPlan): string {
  return modelChoice ?? plan.resolved_model;
}


function summaryFunction(deps: WorkflowStepDeps): SummarizeOneFileFn {
  return deps.summarizeOneFile ?? summarizeOneFileViaSidecar;
}


export async function summarizeFileNode(
  deps: WorkflowStepDeps,
  roomPath: string,
  plan: WorkflowPlan,
  select: FileSelector,
  modelChoice: string | null,
  cancel: CancelFlag
): Promise<WfArtifact> {
  const model = summaryModel(modelChoice, plan);
  const files = resolveFiles(deps.rooms, roomPath, select, plan.input_file_id, plan.prev_run_at);
  if (files.length === 0) {
    return { ...DEFAULT_WF_ARTIFACT, result: "No files matched — nothing to summarize." };
  }
  const summarizeOneFile = summaryFunction(deps);
  const lines: string[] = [];
  for (const [id, name, mime] of files) {
    throwIfCancelled(cancel);
    const full = summarySourceText(deps.rooms, roomPath, id);
    if (full === null || full.trim() === "") {
      continue;
    }
    // The SHARED sentinel policy (jobs.rs::summarize_one_liner), not a second
    // copy of it: a file the model can't describe is marked with the ''
    // sentinel so it leaves the missing-summary set instead of costing one
    // pointless model call every tick, and a file that simply fails no longer
    // aborts the whole run and strands every later file without a description.
    const outcome = await summarizeOneLiner(summarizeOneFile, model, name, mime, full);
    // The CALL failed (timeout / quota / a 502), which says nothing about the
    // file — cache nothing, so this file stays in the missing set and the next
    // run retries it. Caching the sentinel here would have been permanent:
    // every retry selector matches NULL only.
    lines.push(summarizeOutcomeLine(deps.rooms, roomPath, id, name, outcome));
  }
  return { ...DEFAULT_WF_ARTIFACT, result: lines.join("\n") };
}


/** Per-file text budget for a for_each_file map — the local model's Job-tier
 * ctx. Ported from `PER_FILE_CHARS`. */
export const PER_FILE_CHARS = 12_000;


function forEachSourceText(rooms: RoomSource, roomPath: string, fileId: string): string | null {
  const db = pinnedDb(rooms, roomPath);
  return db === null ? null : getFileExtractedText(db, fileId);
}


type PerFilePrompt = { prompt: string; heading: string };


function perFilePrompt(instruction: string, name: string, full: string): PerFilePrompt {
  const chars = Array.from(full);
  const clipped = chars.length > PER_FILE_CHARS;
  const visible = clipped ? chars.slice(0, PER_FILE_CHARS).join("") : full;
  const note = clipped
    ? `\n\n(Only the first ${PER_FILE_CHARS} characters of this file are shown — it is longer. Do not describe it as complete.)`
    : "";
  const heading = clipped ? `## ${name}\n\n_Read the first ${PER_FILE_CHARS} characters only._` : `## ${name}`;
  return { prompt: `${instruction}\n\nFile: ${name}${note}\n\n${visible}`, heading };
}


function forEachResult(sections: readonly string[]): string {
  return sections.length === 0 ? "No files had readable text." : sections.join("\n\n");
}


function workflowPost(deps: WorkflowStepDeps): SidecarPostFn {
  return deps.post ?? sidecarJsonCancellable;
}


export async function forEachFileNode(
  deps: WorkflowStepDeps,
  roomPath: string,
  plan: WorkflowPlan,
  select: FileSelector,
  instructionTemplate: string,
  modelChoice: string | null,
  inputsJoined: string,
  cancel: CancelFlag
): Promise<WfArtifact> {
  const model = summaryModel(modelChoice, plan);
  const files = resolveFiles(deps.rooms, roomPath, select, plan.input_file_id, plan.prev_run_at);
  if (files.length === 0) {
    return { ...DEFAULT_WF_ARTIFACT, result: "No files matched — nothing to do." };
  }
  const instr = interpolate(deps.rooms, roomPath, instructionTemplate, inputsJoined);
  const post = workflowPost(deps);
  const sections: string[] = [];
  for (const [id, name] of files) {
    throwIfCancelled(cancel);
    const full = forEachSourceText(deps.rooms, roomPath, id);
    if (full === null || full.trim() === "") {
      continue;
    }
    const item = perFilePrompt(instr, name, full);
    const response = await wfGenerate(post, model, item.prompt, undefined, cancel);
    sections.push(`${item.heading}\n\n${response.trim()}`);
  }
  return { ...DEFAULT_WF_ARTIFACT, result: forEachResult(sections) };
}


// ============================================================================
// save_file_node (workflow.rs:2316-2427)
// ============================================================================

/** `store_file_bytes` (`commands/files.rs`) — snapshot the file's current
 * state into version history, then overwrite it, as ONE write (a failed
 * overwrite taken separately still cuts a version, evicting the oldest
 * snapshot for nothing). A local copy for the same reason
 * `organizeTools.ts`/`safetyTools.ts`/`filePass.ts`/`scriptRun.ts`/
 * `recBridge.ts`/`editMatch.ts` each already carry one: there is no shared
 * port of this two-call pairing to import, only its two halves. */
export function storeFileBytes(db: Database.Database, id: string, bytes: Uint8Array, text: string | null, cause: string): void {
  inTransaction(db, () => {
    snapshotFileVersion(db, id, cause);
    updateFileContent(db, id, bytes, text);
  });
}
