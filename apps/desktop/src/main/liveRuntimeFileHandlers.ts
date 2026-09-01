/** Live runtime context plus workspace, file-edit, link, and download handlers. */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import type { ToolEffects, ToolOutcome } from "./execTool.js";
import type { Browser } from "./browser/browser.js";
import type { AgentUiRuntime } from "./agentUiSurfaceIpc.js";
import { createBrowserAgentTool } from "./browserAgentTools.js";
import {
  countBatchOps,
  parseBatchOps,
  planBatch,
  planBatchWorkspace,
  planSetCells,
  planSetCellsWorkspace,
  planSingleEdit,
  planSingleEditWorkspace,
  planWriteFile,
  planWriteFileWorkspace,
  type PlannedWrite,
  type PreviewEdit,
} from "./editMatch.js";
import { gatedWrite } from "./editGate.js";
import { availableName, findFileLike, getFileExtractedText, getFileMeta, insertFileFromUrl, setFileExtractedText } from "./db-host/files.js";
import { Readable } from "node:stream";
import { checkpointJob, createJob, getJob, listJobs, setJobStatus, type Job } from "./db-host/jobs.js";
import { agentListScriptsInRoom, clampScriptOutput, scriptOutput } from "./scriptConsent.js";
import { createScriptBytesApprovalRequester, runScriptFile } from "./scriptSurfaceIpc.js";
import { agentRunSkillScript } from "./skillsCmds.js";
import { createDownloadEngineDeps } from "./mediaDownloadSurfaceIpc.js";
import { DOWNLOAD_ENGINE_FETCH, startDownloadJobInner } from "./jobDownload.js";
import { INLINE_DOWNLOAD_BYTES, downloadToTemp, fetchReadable, youtubeTranscript, youtubeVideoId } from "./webFetch.js";
import { sttStatus, type SttModelState } from "./sttTools.js";
import { retranscribeFile } from "./speechSttSurfaceIpc.js";
import { recReadRowStarter, startRecRead } from "./recRead.js";
import { listModels } from "./engineRouting.js";
import { bestLocalDefault } from "./ollamaModels.js";
import { modelSetting } from "./gatherContext.js";
import { runsOnThisMac } from "./capabilities.js";
import { chatStructured, generate } from "./ollamaGenerate.js";
import { resolveLocalGenerateModel } from "./toolSpecs.js";
import { stripThinkSpans } from "./engineRouting.js";
import type { SidecarChatMessage } from "./sidecar.js";
import type { JobRunnerDeps, Lane } from "./jobs.js";
import { spawnJobRunner } from "./jobs.js";
import { atCapacity, QUEUE_FULL, runnerDepsFrom, submit, type RowStarter } from "./jobQueue.js";
import { driveFilePass } from "./filePass.js";
import { locateInImage } from "./visionTools.js";
import { webAccessEnabled } from "./browser/webAccess.js";
import { outboundUrlHides } from "./privacy.js";
import {
  execCreateFileWorkspace,
  execMergeFilesWorkspace,
  execMoveFileWorkspace,
  execOrganizeFilesWorkspace,
  execRenameFileWorkspace,
  execTrashFilesWorkspace,
} from "./organizeTools.js";

export function ok(text: string): ToolOutcome { return { ok: true, text }; }
export function fail(error: unknown): ToolOutcome {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}
export function str(value: unknown): string { return typeof value === "string" ? value : ""; }
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function dryRunSummary(plans: readonly PlannedWrite[]): string {
  const count = plans.reduce((n, plan) => n + Math.max(plan.count, plan.renameTo ? 1 : 0), 0);
  return `Dry run only — ${count} change(s) would affect ${plans.length} file(s):\n${plans.map((p) => `- ${p.realName}${p.renameTo ? ` → ${p.renameTo}` : ""}`).join("\n")}`;
}

export function writeSummary(plan: PlannedWrite): string {
  return `Rewrote "${plan.realName}" (${plan.after.length} characters). Saved to the room — its prior version is in History and can be restored.`;
}

export function jobStatusLine(job: (ReturnType<typeof listJobs>)[number]): string {
  const why = job.parkedReason ? ` — ${job.parkedReason} Resume picks it up here.` : "";
  return `- [${job.id.slice(0, 8)}] ${job.title} — ${job.status} (${job.cursor} of ${job.total} steps done)${why}`;
}

export function detailedJobStatus(job: (ReturnType<typeof listJobs>)[number]): string {
  const paused = job.parkedReason ? `\nWhy it's paused: ${job.parkedReason}` : "";
  const error = job.error ? `\nError: ${job.error}` : "";
  return `[${job.id}] ${job.title}\nStatus: ${job.status} (${job.cursor} of ${job.total} steps done)${paused}${error}`;
}

export function jobStatusReply(args: Record<string, unknown>, jobs: ReturnType<typeof listJobs>): string {
  if (jobs.length === 0) return "There are no background jobs in this room.";
  const query = str(args.job_id).trim().toLowerCase();
  if (!query) return jobs.slice(0, 8).map(jobStatusLine).join("\n");
  const matches = jobs.filter((job) => job.id.toLowerCase().startsWith(query));
  if (matches.length === 0) return `No background job matches id "${query}". Call job_status with no arguments to see every job's id.`;
  if (matches.length > 1) return `"${query}" matches ${matches.length} jobs; be more specific:\n${matches.map(jobStatusLine).join("\n")}`;
  return detailedJobStatus(matches[0]!);
}

export async function resolveLocalModel(state: RoomManagerState): Promise<{ model: string; lane: Lane }> {
  if (!state.room) throw new Error("No room is open.");
  const installed = await listModels();
  const model = modelSetting(state.room.conn) ?? bestLocalDefault(installed);
  return { model, lane: runsOnThisMac(model) ? "local_llm" : "cloud" };
}

export interface LiveRuntimeToolOptions {
  state: RoomManagerState;
  roomDeps: RoomManagerDeps;
  userDataDir: string;
  resourcesPath: string | null;
  emit: EventSender;
  browser: Browser;
  agentUi: AgentUiRuntime;
  sttModelState: SttModelState;
  /** Test seam for the long-running transcription operation. */
  retranscribe?: typeof retranscribeFile;
}

export type LiveRoom = NonNullable<RoomManagerState["room"]>;
export type WorkspaceLiveRoom = LiveRoom & { workspace: NonNullable<LiveRoom["workspace"]> };
export type RuntimeToolHandler = (
  context: LiveRuntimeContext,
  room: LiveRoom,
  args: Record<string, unknown>,
  effects: ToolEffects,
) => Promise<ToolOutcome | null>;
export type WorkspaceToolHandler = (
  context: LiveRuntimeContext,
  room: WorkspaceLiveRoom,
  args: Record<string, unknown>,
  effects: ToolEffects,
) => Promise<ToolOutcome | null>;

export interface LiveRuntimeContext {
  state: RoomManagerState;
  roomDeps: RoomManagerDeps;
  userDataDir: string;
  resourcesPath: string | null;
  emit: EventSender;
  sttModelState: SttModelState;
  retranscribe?: typeof retranscribeFile;
  sttBusy: Map<string, string>;
}

export function currentGatedRoom(room: LiveRoom) {
  return {
    db: room.conn,
    path: room.path,
    ...(room.workspace === undefined ? {} : { workspace: room.workspace }),
  };
}

export function liveGated(context: LiveRuntimeContext) {
  return {
    rooms: {
      currentRoom: () => {
        const room = context.state.room;
        return room === null ? null : currentGatedRoom(room);
      },
    },
    editPending: context.state.editPending,
    emit: context.emit,
  };
}

export function workspaceCreate(
  context: LiveRuntimeContext, room: WorkspaceLiveRoom, args: Record<string, unknown>, effects: ToolEffects,
): Promise<ToolOutcome | null> {
  return execCreateFileWorkspace(room.conn, room.workspace, args, effects, { runId: null, emit: context.emit });
}

export function workspaceRename(
  context: LiveRuntimeContext, room: WorkspaceLiveRoom, args: Record<string, unknown>, effects: ToolEffects,
): Promise<ToolOutcome | null> {
  return execRenameFileWorkspace(room.conn, room.workspace, args, effects, context.emit);
}

export function workspaceMove(
  context: LiveRuntimeContext, room: WorkspaceLiveRoom, args: Record<string, unknown>, effects: ToolEffects,
): Promise<ToolOutcome | null> {
  return execMoveFileWorkspace(room.conn, room.workspace, args, effects, context.emit);
}

export function workspaceOrganize(
  context: LiveRuntimeContext, room: WorkspaceLiveRoom, args: Record<string, unknown>, effects: ToolEffects,
): Promise<ToolOutcome | null> {
  return execOrganizeFilesWorkspace(room.conn, room.workspace, args, effects, context.emit);
}

export function workspaceTrash(
  context: LiveRuntimeContext, room: WorkspaceLiveRoom, args: Record<string, unknown>, effects: ToolEffects,
): Promise<ToolOutcome | null> {
  return execTrashFilesWorkspace(room.conn, room.workspace, args, effects, context.emit);
}

export function workspaceMerge(
  context: LiveRuntimeContext, room: WorkspaceLiveRoom, args: Record<string, unknown>, effects: ToolEffects,
): Promise<ToolOutcome | null> {
  return execMergeFilesWorkspace(room.conn, room.workspace, args, effects, context.emit);
}

export const WORKSPACE_TOOL_HANDLERS: Record<string, WorkspaceToolHandler> = {
  create_file: workspaceCreate,
  rename_file: workspaceRename,
  move_file: workspaceMove,
  organize_files: workspaceOrganize,
  trash_files: workspaceTrash,
  merge_files: workspaceMerge,
};

export function imageAlreadyMarked(existing: unknown, fileId: string): boolean {
  return typeof existing === "object" && existing !== null && (existing as Record<string, unknown>).fileId === fileId;
}

export function markedImageMessage(realName: string, find: string, count: number): string {
  return count === 0
    ? `I couldn't find ${find} in "${realName}".`
    : `Marked ${count} match${count === 1 ? "" : "es"} for ${find} in "${realName}".`;
}

export async function markImage(
  _context: LiveRuntimeContext,
  room: LiveRoom,
  args: Record<string, unknown>,
  effects: ToolEffects,
): Promise<ToolOutcome> {
  const [fileId, realName] = findFileLike(room.conn, str(args.image_name));
  const existing = effects.boxes;
  if (imageAlreadyMarked(existing, fileId)) {
    return ok(`The image "${realName}" is already marked.`);
  }
  const boxes = await locateInImage(room.conn, fileId, str(args.find));
  effects.boxes = { fileId, name: realName, boxes };
  return ok(markedImageMessage(realName, str(args.find), boxes.length));
}

export function numericOccurrence(args: Record<string, unknown>): number | undefined {
  return typeof args.occurrence === "number" && Number.isInteger(args.occurrence) ? args.occurrence : undefined;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  return typeof args[key] === "string" ? args[key] : undefined;
}

export function previewEdit(args: Record<string, unknown>): PreviewEdit {
  const oldText = str(args.old_text);
  if (!oldText) throw new Error("old_text is required — copy the exact text to replace.");
  const all = args.all === true;
  const occurrence = numericOccurrence(args);
  if (occurrence !== undefined && all) throw new Error("occurrence and all: true can't both be set.");
  return {
    name: str(args.name), oldText, newText: str(args.new_text), all,
    prefixContext: optionalString(args, "prefix_context"),
    suffixContext: optionalString(args, "suffix_context"),
    occurrence, section: optionalString(args, "section"),
  };
}

export function singleEditPlans(room: LiveRoom, edit: PreviewEdit): Promise<PlannedWrite[]> | PlannedWrite[] {
  return room.workspace === undefined
    ? planSingleEdit(room.conn, edit)
    : planSingleEditWorkspace(room.conn, room.workspace, edit);
}

export function gatedSingleEdit(edit: PreviewEdit) {
  return (db: LiveRoom["conn"], workspace: LiveRoom["workspace"]) => (
    workspace === undefined ? planSingleEdit(db, edit) : planSingleEditWorkspace(db, workspace, edit)
  );
}

export function singleEditOutcome(result: Awaited<ReturnType<typeof gatedWrite>>, effects: ToolEffects): ToolOutcome {
  if (result.kind === "declined") return ok(result.message);
  if (result.kind === "error") return fail(result.error.message);
  const plan = result.plans[0]!;
  effects.editOutcomes.push({ tool: "edit_file", outcome: plan.method ?? "exact", n: plan.count });
  const fuzzy = plan.method === "fuzzy" ? "Matched despite quote/spacing differences. " : "";
  return ok(`${fuzzy}Replaced ${plan.count} occurrence(s) in "${plan.realName}". Saved to the room and undoable from History.`);
}

export async function editFile(
  context: LiveRuntimeContext,
  room: LiveRoom,
  args: Record<string, unknown>,
  effects: ToolEffects,
): Promise<ToolOutcome> {
  const edit = previewEdit(args);
  if (args.dry_run === true) return ok(dryRunSummary(await singleEditPlans(room, edit)));
  return singleEditOutcome(await gatedWrite("edit_file", "AI edit", liveGated(context), effects, gatedSingleEdit(edit)), effects);
}

export function batchPlans(room: LiveRoom, args: Record<string, unknown>) {
  const ops = parseBatchOps(args);
  return { ops, plans: room.workspace === undefined ? planBatch(room.conn, ops) : planBatchWorkspace(room.conn, room.workspace, ops) };
}

export function gatedBatch(ops: ReturnType<typeof parseBatchOps>) {
  return (db: LiveRoom["conn"], workspace: LiveRoom["workspace"]) => (
    workspace === undefined ? planBatch(db, ops) : planBatchWorkspace(db, workspace, ops)
  );
}

export function batchEditOutcome(
  result: Awaited<ReturnType<typeof gatedWrite>>,
  counts: ReturnType<typeof countBatchOps>,
  effects: ToolEffects,
): ToolOutcome {
  if (result.kind === "declined") return ok(result.message);
  if (result.kind === "error") return fail(result.error.message);
  const total = counts.edits + counts.renames;
  effects.editOutcomes.push({ tool: "edit_files", outcome: "applied", files: result.plans.length, n: total });
  return ok(`Applied ${total} change(s) across ${result.plans.length} file(s) atomically.`);
}

export async function editFiles(
  context: LiveRuntimeContext,
  room: LiveRoom,
  args: Record<string, unknown>,
  effects: ToolEffects,
): Promise<ToolOutcome> {
  const { ops, plans } = batchPlans(room, args);
  if (args.dry_run === true) return ok(dryRunSummary(await plans));
  const counts = countBatchOps(ops);
  const result = await gatedWrite("edit_files", `AI edit (batch ${randomUUID().slice(0, 8)})`, liveGated(context), effects, gatedBatch(ops));
  return batchEditOutcome(result, counts, effects);
}

export function gatedWriteFile(args: Record<string, unknown>) {
  return (db: LiveRoom["conn"], workspace: LiveRoom["workspace"]) => (
    workspace === undefined
      ? planWriteFile(db, str(args.name), str(args.content))
      : planWriteFileWorkspace(db, workspace, str(args.name), str(args.content))
  );
}

export function writeFileOutcome(result: Awaited<ReturnType<typeof gatedWrite>>): ToolOutcome {
  if (result.kind === "declined") return ok(result.message);
  return result.kind === "error" ? fail(result.error.message) : ok(writeSummary(result.plans[0]!));
}

export async function writeFile(
  context: LiveRuntimeContext,
  _room: LiveRoom,
  args: Record<string, unknown>,
  effects: ToolEffects,
): Promise<ToolOutcome> {
  return writeFileOutcome(await gatedWrite("write_file", "AI rewrite", liveGated(context), effects, gatedWriteFile(args)));
}

export function cellRow(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function validCell(row: Record<string, unknown>): string {
  const cell = str(row.cell).trim().toUpperCase();
  if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(cell)) throw new Error(`Invalid cell reference: ${cell || "(empty)"}.`);
  return cell;
}

export function requiredCellValue(row: Record<string, unknown>, cell: string): unknown {
  if (!("value" in row)) throw new Error(`${cell} has no value — use "" to clear it.`);
  if (row.value === null) throw new Error(`${cell} has no value — use "" to clear it.`);
  if (row.value === undefined) throw new Error(`${cell} has no value — use "" to clear it.`);
  return row.value;
}

export function cellText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function cellUpdate(value: unknown): [string, string] {
  const row = cellRow(value);
  const cell = validCell(row);
  return [cell, cellText(requiredCellValue(row, cell))];
}

export function cellUpdates(args: Record<string, unknown>): [string, string][] {
  const raw = Array.isArray(args.updates) ? args.updates : [];
  const updates = raw.map(cellUpdate);
  if (updates.length === 0) throw new Error("No cells given — pass updates: [{cell, value}, …].");
  return updates;
}

export function gatedCells(args: Record<string, unknown>, updates: [string, string][]) {
  return (db: LiveRoom["conn"], workspace: LiveRoom["workspace"]) => {
    const sheet = typeof args.sheet === "string" ? args.sheet : null;
    return workspace === undefined
      ? planSetCells(db, str(args.name), sheet, updates)
      : planSetCellsWorkspace(db, workspace, str(args.name), sheet, updates);
  };
}

export function setCellsOutcome(result: Awaited<ReturnType<typeof gatedWrite>>, updates: [string, string][]): ToolOutcome {
  if (result.kind === "declined") return ok(result.message);
  if (result.kind === "error") return fail(result.error.message);
  return ok(`Set ${updates.map(([cell, value]) => `${cell}=${value}`).join(", ")} in "${result.plans[0]!.realName}".`);
}

export async function setCells(
  context: LiveRuntimeContext,
  _room: LiveRoom,
  args: Record<string, unknown>,
  effects: ToolEffects,
): Promise<ToolOutcome> {
  const updates = cellUpdates(args);
  return setCellsOutcome(await gatedWrite("set_cells", "AI cell change", liveGated(context), effects, gatedCells(args, updates)), updates);
}

export function webRefusal(room: LiveRoom, url: string): ToolOutcome | null {
  const hidden = outboundUrlHides(url);
  if (hidden !== null) return ok(`Not fetched: this URL carries ${hidden} protected name(s), and Cloud privacy is on.`);
  return webAccessEnabled(room.conn) ? null : ok("Web access is turned off in Settings → Online features.");
}

export async function fetchedPage(url: string): Promise<{ title: string; text: string }> {
  if (youtubeVideoId(url)) {
    const transcript = await youtubeTranscript(url);
    return { title: transcript.title, text: transcript.transcript };
  }
  const page = await fetchReadable(url);
  return { title: page.title || new URL(url).hostname, text: page.text };
}

export async function saveLink(
  context: LiveRuntimeContext,
  room: LiveRoom,
  args: Record<string, unknown>,
  effects: ToolEffects,
): Promise<ToolOutcome> {
  const url = str(args.url).trim();
  const refusal = webRefusal(room, url);
  if (refusal !== null) return refusal;
  const { title, text } = await fetchedPage(url);
  const name = availableName(room.conn, `${title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 100) || "Web source"}.md`);
  const content = `# ${title}\n\nSource: ${url}\n\n${text}`;
  const meta = room.workspace === undefined
    ? insertFileFromUrl(room.conn, name, "text/markdown", Buffer.from(content), content, "web", url)
    : await room.workspace.createFile(name, Readable.from([Buffer.from(content)]), "web").then((entry) => {
        setFileExtractedText(room.conn, entry.fileId, content);
        room.conn.prepare("UPDATE files SET origin_url = ?, mime_type = 'text/markdown' WHERE id = ?").run(url, entry.fileId);
        return getFileMeta(room.conn, entry.fileId);
      });
  context.emit("room-files-changed", {});
  effects.wrote = true;
  return ok(`Saved "${meta.name}" into the room.`);
}

export async function downloadUrl(
  context: LiveRuntimeContext,
  room: LiveRoom,
  args: Record<string, unknown>,
  effects: ToolEffects,
): Promise<ToolOutcome> {
  const url = str(args.url).trim();
  const refusal = webRefusal(room, url);
  if (refusal !== null) return refusal;
  const outcome = await downloadToTemp(url, INLINE_DOWNLOAD_BYTES, undefined, () => undefined);
  if (outcome.kind === "tooLarge") return largeDownload(context, url);
  return importDownload(context, outcome.downloaded.path, outcome.downloaded.fileName, url, effects);
}

export function largeDownload(context: LiveRuntimeContext, url: string): ToolOutcome {
  const queue = context.roomDeps.jobQueue;
  if (!queue) throw new Error("The background job queue is unavailable.");
  const id = startDownloadJobInner({ ...queue, ...createDownloadEngineDeps(context.state, context.userDataDir, context.emit) }, url, DOWNLOAD_ENGINE_FETCH);
  return ok(`This file is larger than 64 MB, so it is continuing as background job ${id}. Track it with job_status.`);
}

export async function importDownload(
  context: LiveRuntimeContext,
  tempPath: string,
  fileName: string,
  url: string,
  effects: ToolEffects,
): Promise<ToolOutcome> {
  const engine = createDownloadEngineDeps(context.state, context.userDataDir, context.emit);
  try {
    const meta = await engine.importDownload!(tempPath, fileName, url);
    effects.wrote = true;
    return ok(`Downloaded "${meta.name}" into the room.`);
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}
