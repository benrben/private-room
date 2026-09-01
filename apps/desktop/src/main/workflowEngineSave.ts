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
import { Readable } from "node:stream";
import { pinnedDb, type RoomSource, type Step } from "./jobs.js";
import { availableName, getFileExtractedText, getFileMeta, insertFile, setFileExtractedText, type FileMeta } from "./db-host/files.js";
import { queryOpt } from "./db-host/util.js";
import { type PublishedRef } from "./filePass.js";
import { htmlDocument } from "./docsHtml.js";
import { appendIntoHtml, cleanSaveName } from "./workflowSaveFile.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";
import { parseWorkflowNode, type WfArtifact, type WorkflowNode } from "./workflowModel.js";
import { interpolate, ROOM_GONE } from "./workflowEngineInputs.js";
import { stepParamsRecord, storeFileBytes } from "./workflowEngineSteps.js";


type SaveFileTarget = {
  name: string;
  mime: string;
  extension: string;
  content: string;
};


function saveFileTarget(rooms: RoomSource, roomPath: string, nameTemplate: string, format: string, inputs: string): SaveFileTarget {
  const rawName = cleanSaveName(interpolate(rooms, roomPath, nameTemplate, inputs));
  const extension = format === "md" ? "md" : "html";
  const name = rawName.toLowerCase().endsWith(`.${extension}`) ? rawName : `${rawName}.${extension}`;
  const mime = extension === "md" ? "text/markdown" : "text/html";
  const content = extension === "md" ? inputs : htmlDocument(name, inputs);
  return { name, mime, extension, content };
}


function insertGeneratedSaveFile(db: Database.Database, target: SaveFileTarget): FileMeta {
  return insertFile(db, target.name, target.mime, Buffer.from(target.content, "utf8"), target.content, "generated");
}


function overwriteSavedFile(db: Database.Database, id: string, content: string, cause: string): FileMeta {
  storeFileBytes(db, id, Buffer.from(content, "utf8"), content, cause);
  return getFileMeta(db, id);
}


function appendSavedFile(db: Database.Database, id: string, target: SaveFileTarget, inputs: string, cause: string): FileMeta {
  const old = getFileExtractedText(db, id) ?? "";
  const content = target.extension === "md" ? `${old}\n\n${inputs}` : appendIntoHtml(old, target.name, inputs);
  return overwriteSavedFile(db, id, content, cause);
}


function reusesGeneratedSaveFile(mode: string): boolean {
  return mode === "overwrite" || mode === "append";
}


function newestGeneratedSaveFileId(db: Database.Database, name: string): string | null {
  return queryOpt(
    db,
    "SELECT id FROM files WHERE name = ? AND source = 'generated' AND trashed_at IS NULL " +
      "ORDER BY created_at DESC LIMIT 1",
    [name],
    (row) => row[0] as string
  );
}


function saveByName(db: Database.Database, target: SaveFileTarget, mode: string, inputs: string, cause: string): FileMeta {
  if (!reusesGeneratedSaveFile(mode)) return insertGeneratedSaveFile(db, target);
  const existingId = newestGeneratedSaveFileId(db, target.name);
  if (existingId === null) return insertGeneratedSaveFile(db, target);
  if (mode === "append") return appendSavedFile(db, existingId, target, inputs, cause);
  return overwriteSavedFile(db, existingId, target.content, cause);
}


function saveFileMeta(
  db: Database.Database,
  target: SaveFileTarget,
  mode: string,
  inputs: string,
  existing: WfArtifact | null,
  cause: string
): FileMeta {
  const previousId = existing?.file_id ?? null;
  if (previousId === null) return saveByName(db, target, mode, inputs, cause);
  if (getFileExtractedText(db, previousId) === null) return insertGeneratedSaveFile(db, target);
  return overwriteSavedFile(db, previousId, target.content, cause);
}


/**
 * Write the workflow's output as a room file. Idempotent: if this node already
 * created a file (recorded in its artifact), overwrite that file id. Every
 * overwrite is snapshotted first, so a scheduled run can never destroy a page
 * the user edited — Time Machine restores it. Ported from `save_file_node`.
 */
export function saveFileNode(
  rooms: RoomSource,
  roomPath: string,
  nameTemplate: string,
  format: string,
  mode: string,
  inputs: string,
  existing: WfArtifact | null,
  published: PublishedRef,
  cause: string,
  notifyFilesChanged?: () => void
): { result: string; fileId: string } {
  const target = saveFileTarget(rooms, roomPath, nameTemplate, format, inputs);

  const db = pinnedDb(rooms, roomPath);
  if (db === null) {
    throw new Error(ROOM_GONE);
  }

  const meta = saveFileMeta(db, target, mode, inputs, existing, cause);

  notifyFilesChanged?.();
  published.value = meta;
  return { result: `Saved "${meta.name}" into the room.`, fileId: meta.id };
}


type WorkspaceFileRow = { storage_kind: string; content_sha256: string | null };


function workspaceFileRow(db: Database.Database, id: string): WorkspaceFileRow | undefined {
  return db.prepare(
    "SELECT storage_kind, content_sha256 FROM files WHERE id = ? AND trashed_at IS NULL",
  ).get(id) as WorkspaceFileRow | undefined;
}


async function writeWorkspaceSaveFile(
  db: Database.Database,
  workspace: WorkspaceService,
  id: string,
  target: SaveFileTarget,
  cause: string,
): Promise<FileMeta> {
  const row = workspaceFileRow(db, id);
  if (row === undefined || row.storage_kind !== "workspace") {
    throw new Error("That workflow output is no longer a normal workspace file.");
  }
  await workspace.snapshotVersion(id, cause);
  await workspace.writeAtomic(id, Readable.from([Buffer.from(target.content, "utf8")]), row.content_sha256 ?? undefined);
  setFileExtractedText(db, id, target.content);
  db.prepare("UPDATE files SET mime_type = ? WHERE id = ?").run(target.mime, id);
  return getFileMeta(db, id);
}


async function createWorkspaceSaveFile(
  db: Database.Database,
  workspace: WorkspaceService,
  target: SaveFileTarget,
): Promise<FileMeta> {
  const name = availableName(db, target.name);
  const entry = await workspace.createFile(name, Readable.from([Buffer.from(target.content, "utf8")]), "generated");
  setFileExtractedText(db, entry.fileId, target.content);
  db.prepare("UPDATE files SET mime_type = ? WHERE id = ?").run(target.mime, entry.fileId);
  return getFileMeta(db, entry.fileId);
}


function isWorkspaceSaveFile(db: Database.Database, id: string): boolean {
  return workspaceFileRow(db, id)?.storage_kind === "workspace";
}


async function saveRecordedWorkspaceOutput(
  db: Database.Database,
  workspace: WorkspaceService,
  target: SaveFileTarget,
  existing: WfArtifact | null,
  cause: string,
): Promise<FileMeta | null> {
  const previousId = existing?.file_id ?? null;
  if (previousId === null) return null;
  return isWorkspaceSaveFile(db, previousId)
    ? writeWorkspaceSaveFile(db, workspace, previousId, target, cause)
    : createWorkspaceSaveFile(db, workspace, target);
}


export function appendedWorkspaceContent(db: Database.Database, id: string, target: SaveFileTarget, inputs: string): string {
  const existing = getFileExtractedText(db, id) ?? "";
  return target.extension === "md" ? `${existing}\n\n${inputs}` : appendIntoHtml(existing, target.name, inputs);
}


export async function saveNamedWorkspaceOutput(
  db: Database.Database,
  workspace: WorkspaceService,
  target: SaveFileTarget,
  mode: string,
  inputs: string,
  cause: string,
): Promise<FileMeta> {
  if (!reusesGeneratedSaveFile(mode)) return createWorkspaceSaveFile(db, workspace, target);
  const found = queryOpt(
    db,
    "SELECT id, storage_kind FROM files WHERE name = ? AND source = 'generated' AND trashed_at IS NULL " +
      "ORDER BY created_at DESC LIMIT 1",
    [target.name],
    (row) => ({ id: row[0] as string, storageKind: row[1] as string }),
  );
  if (found === null || found.storageKind !== "workspace") return createWorkspaceSaveFile(db, workspace, target);
  const content = mode === "append" ? appendedWorkspaceContent(db, found.id, target, inputs) : target.content;
  return writeWorkspaceSaveFile(db, workspace, found.id, { ...target, content }, cause);
}


async function saveWorkspaceOutput(
  db: Database.Database,
  workspace: WorkspaceService,
  target: SaveFileTarget,
  mode: string,
  inputs: string,
  existing: WfArtifact | null,
  cause: string,
): Promise<FileMeta> {
  const recorded = await saveRecordedWorkspaceOutput(db, workspace, target, existing, cause);
  return recorded ?? saveNamedWorkspaceOutput(db, workspace, target, mode, inputs, cause);
}


/** Workspace-room form of {@link saveFileNode}. Legacy rooms keep the exact
 * synchronous database implementation above; hybrid rooms publish accepted
 * workflow output as a normal file and retain only metadata/search/history in
 * SQLCipher. */
export async function saveFileNodeHybrid(
  rooms: RoomSource,
  roomPath: string,
  nameTemplate: string,
  format: string,
  mode: string,
  inputs: string,
  existing: WfArtifact | null,
  published: PublishedRef,
  cause: string,
  notifyFilesChanged?: () => void
): Promise<{ result: string; fileId: string }> {
  const pinned = rooms.current();
  if (pinned === null || pinned.path !== roomPath) throw new Error(ROOM_GONE);
  if (pinned.workspace === undefined) {
    return saveFileNode(
      rooms, roomPath, nameTemplate, format, mode, inputs, existing,
      published, cause, notifyFilesChanged,
    );
  }

  const db = pinned.db;
  const workspace = pinned.workspace;
  const target = saveFileTarget(rooms, roomPath, nameTemplate, format, inputs);
  const meta = await saveWorkspaceOutput(db, workspace, target, mode, inputs, existing, cause);

  notifyFilesChanged?.();
  published.value = meta;
  return { result: `Saved "${meta.name}" into the room.`, fileId: meta.id };
}


// ============================================================================
// execute_workflow_step / run_workflow_node (workflow.rs:1496-2107)
// ============================================================================

/**
 * Execute one workflow step and mark the node on the live pipeline diagram.
 *
 * The badge is decided HERE and nowhere else. The work itself is full of error
 * paths — a room closed mid-run, a Stop inside a per-file loop, a store that
 * failed — and each one used to return straight past the diagram, so the box
 * either lost its badge when the run ended or spun forever. One funnel means a
 * step that broke is always the box that turns red. Ported from
 * `execute_workflow_step`; returns a `StepResult` rather than throwing (see
 * this module's DEVIATIONS), so it plugs straight into `jobs.ts`'s `runPlan`.
 */
export function parsedStepNode(step: Step): WorkflowNode | null {
  try {
    return parseWorkflowNode(stepParamsRecord(step).node);
  } catch {
    return null;
  }
}
