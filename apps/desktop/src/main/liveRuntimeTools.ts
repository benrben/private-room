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
import {
  WORKSPACE_TOOL_HANDLERS,
  currentGatedRoom,
  downloadUrl,
  editFile,
  editFiles,
  fail,
  jobStatusReply,
  markImage,
  ok,
  resolveLocalModel,
  saveLink,
  setCells,
  sleep,
  str,
  writeFile,
  type LiveRoom,
  type LiveRuntimeContext,
  type LiveRuntimeToolOptions,
  type RuntimeToolHandler,
  type WorkspaceLiveRoom,
} from "./liveRuntimeFileHandlers.js";

export type { LiveRuntimeToolOptions } from "./liveRuntimeFileHandlers.js";

async function listScripts(
  context: LiveRuntimeContext,
  room: LiveRoom,
  _args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  return ok(await agentListScriptsInRoom(currentGatedRoom(room), context.userDataDir));
}

function scriptJobOutcome(room: LiveRoom, jobId: string, realName: string): ToolOutcome | null {
  const current = room;
  const job = getJob(current.conn, jobId);
  if (job.status === "done") return ok(clampScriptOutput(realName, scriptOutput(current.conn, jobId)));
  if (job.status === "error") return fail(job.error ?? `${realName} failed.`);
  if (job.status === "paused") return ok(`Started ${realName}, but it is paused. Resume it from Jobs.`);
  return null;
}

async function waitForScript(
  context: LiveRuntimeContext,
  room: LiveRoom,
  jobId: string,
  realName: string,
): Promise<ToolOutcome> {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const current = context.state.room;
    if (!current || current.path !== room.path) throw new Error("The room was closed while the script ran.");
    const outcome = scriptJobOutcome(current, jobId, realName);
    if (outcome !== null) return outcome;
    await sleep(250);
  }
  return ok(`Started ${realName} as background job ${jobId}; it is still running.`);
}

async function runScript(
  context: LiveRuntimeContext,
  room: LiveRoom,
  args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  const [fileId, realName] = findFileLike(room.conn, str(args.name));
  const jobId = await runScriptFile(context.state, context.roomDeps, context.userDataDir, context.emit, fileId);
  return waitForScript(context, room, jobId, realName);
}

function sttBusySuffix(context: LiveRuntimeContext): string {
  return context.sttBusy.size
    ? ` Transcribing ${[...context.sttBusy.keys()].join(", ")} right now.`
    : " Nothing is transcribing right now.";
}

function sttStatusOutcome(status: ReturnType<typeof sttStatus>, busy: string): ToolOutcome {
  if (status.installed) return ok(`The on-device speech model is installed and ready.${busy}`);
  return status.downloading
    ? ok("The on-device speech model is still downloading.")
    : ok(`The on-device speech model is not installed (${status.sizeMb} MB).`);
}

async function sttStatusTool(
  context: LiveRuntimeContext,
  _room: LiveRoom,
  _args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  return sttStatusOutcome(sttStatus(context.userDataDir, context.resourcesPath, context.sttModelState), sttBusySuffix(context));
}

function unavailableStt(status: ReturnType<typeof sttStatus>): ToolOutcome | null {
  if (status.installed) return null;
  const message = status.downloading
    ? "The on-device speech model is still downloading. Try again when it is ready."
    : `The on-device speech model is not installed (${status.sizeMb} MB).`;
  return fail(message);
}

function busyRetranscription(context: LiveRuntimeContext, realName: string): ToolOutcome | null {
  const jobId = context.sttBusy.get(realName);
  return jobId === undefined ? null : fail(`Re-transcription job ${jobId} for “${realName}” is still running.`);
}

function retranscriptionReceipt(jobId: string, fileId: string, fileName: string, transcript: string): string {
  const status = transcript === "" ? "no-speech" : "completed";
  return JSON.stringify({ jobId, fileId, fileName, status, characters: transcript.length });
}

function retranscriptionMessage(receipt: string, realName: string, transcript: string): ToolOutcome {
  if (transcript === "") return ok(`TRANSCRIPTION_RECEIPT ${receipt}\nNo speech was detected in “${realName}”.`);
  const preview = transcript.length > 16_000
    ? `${transcript.slice(0, 16_000)}\n… (transcript continues in the room file)`
    : transcript;
  return ok(`TRANSCRIPTION_RECEIPT ${receipt}\nTranscript:\n${preview}`);
}

function completeRetranscription(room: LiveRoom, jobId: string, fileId: string, realName: string): ToolOutcome {
  const transcript = getFileExtractedText(room.conn, fileId)?.trim() ?? "";
  const receipt = retranscriptionReceipt(jobId, fileId, realName, transcript);
  const status = transcript === "" ? "no-speech" : "completed";
  checkpointJob(room.conn, jobId, 1, { fileId, status, characters: transcript.length });
  setJobStatus(room.conn, jobId, "done", null);
  return retranscriptionMessage(receipt, realName, transcript);
}

function failedRetranscription(room: LiveRoom | null, roomPath: string, jobId: string, error: unknown): ToolOutcome {
  const message = error instanceof Error ? error.message : String(error);
  if (room !== null && room.path === roomPath) setJobStatus(room.conn, jobId, "error", message);
  return fail(`Re-transcription job ${jobId} failed: ${message}`);
}

async function retranscribe(
  context: LiveRuntimeContext,
  room: LiveRoom,
  args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  const [fileId, realName] = findFileLike(room.conn, str(args.name));
  const unavailable = unavailableStt(sttStatus(context.userDataDir, context.resourcesPath, context.sttModelState));
  if (unavailable !== null) return unavailable;
  const busy = busyRetranscription(context, realName);
  if (busy !== null) return busy;
  const jobId = createJob(room.conn, "retranscribe", `Re-transcribe — ${realName}`, { fileId, fileName: realName }, 1);
  setJobStatus(room.conn, jobId, "running", null);
  context.sttBusy.set(realName, jobId);
  try {
    await activeRetranscriber(context)(context.state, context.userDataDir, context.resourcesPath, context.emit, fileId);
    return completeRetranscription(openTranscriptionRoom(context.state.room, room.path), jobId, fileId, realName);
  } catch (error) {
    return failedRetranscription(context.state.room, room.path, jobId, error);
  } finally {
    context.sttBusy.delete(realName);
  }
}

function activeRetranscriber(context: LiveRuntimeContext): typeof retranscribeFile {
  return context.retranscribe ?? retranscribeFile;
}

function openTranscriptionRoom(room: LiveRoom | null, expectedPath: string): LiveRoom {
  if (room === null) throw new Error("The room was closed while transcription was running.");
  if (room.path !== expectedPath) throw new Error("The room was closed while transcription was running.");
  return room;
}

async function readRecording(
  context: LiveRuntimeContext,
  room: LiveRoom,
  args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  const queue = context.roomDeps.jobQueue;
  if (!queue) throw new Error("The background job queue is unavailable.");
  const [fileId, realName] = findFileLike(room.conn, str(args.name));
  const jobId = await startRecRead(queue, recReadOptions(context), fileId);
  return ok(`Started reading "${realName}" as background job ${jobId}. Chapters, highlights and notes appear when it finishes.`);
}

function recReadOptions(context: LiveRuntimeContext) {
  return {
    resolvePassEngine: async () => {
      const picked = await resolveLocalModel(context.state);
      return { chatModel: picked.model, lane: picked.lane };
    },
    onReadDone: (event: Parameters<typeof context.emit>[1]) => context.emit("rec-read-done", event),
  };
}

async function runSkillScript(
  context: LiveRuntimeContext,
  room: LiveRoom,
  args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  return ok(await agentRunSkillScript(room.conn, args, {
    cacheDir: path.join(context.userDataDir, "cache"),
    approveScriptBytes: createScriptBytesApprovalRequester(context.state, context.userDataDir, context.emit),
  }));
}

async function startFilePass(
  context: LiveRuntimeContext,
  room: LiveRoom,
  args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  const queue = context.roomDeps.jobQueue;
  if (!queue) throw new Error("The background job queue is unavailable.");
  if (atCapacity(room.conn)) throw new Error(QUEUE_FULL);
  const [fileId, realName] = findFileLike(room.conn, str(args.name));
  const instruction = str(args.instruction).trim() || "Summarize this file completely and thoroughly.";
  const mode = str(args.mode) === "stitch" ? "stitch" : "merge";
  const jobId = createJob(room.conn, "file_pass", `Full pass — ${realName}`, { fileId, fileName: realName, instruction, mode }, 1);
  await submit(queue, jobId);
  return ok(`Started a full pass over "${realName}" as job ${jobId}. The result will be saved as a new room file; progress is visible in Jobs.`);
}

async function jobStatus(
  _context: LiveRuntimeContext,
  room: LiveRoom,
  args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  return ok(jobStatusReply(args, listJobs(room.conn)));
}

function localPrompt(args: Record<string, unknown>): string {
  const prompt = str(args.prompt).trim();
  if (!prompt) throw new Error("local_generate needs a non-empty `prompt`.");
  return prompt;
}

function localMessages(args: Record<string, unknown>, prompt: string): SidecarChatMessage[] {
  const messages: SidecarChatMessage[] = [];
  if (str(args.system).trim()) messages.push({ role: "system", content: str(args.system) });
  messages.push({ role: "user", content: prompt });
  return messages;
}

function localTemperature(args: Record<string, unknown>): number | null {
  return typeof args.temperature === "number" ? args.temperature : null;
}

function structuredSchema(args: Record<string, unknown>): object | null {
  return typeof args.schema === "object" && args.schema !== null ? args.schema : null;
}

async function generatedText(
  model: string,
  messages: SidecarChatMessage[],
  temperature: number | null,
  schema: object | null,
): Promise<string> {
  if (schema !== null) return chatStructured(model, messages, temperature, "5m", schema);
  return stripThinkSpans(await generate(model, messages, temperature, "5m")).trim();
}

async function localGenerate(
  _context: LiveRuntimeContext,
  room: LiveRoom,
  args: Record<string, unknown>,
  _effects: ToolEffects,
): Promise<ToolOutcome> {
  const prompt = localPrompt(args);
  const model = resolveLocalGenerateModel(modelSetting(room.conn) ?? undefined, await listModels(), runsOnThisMac, bestLocalDefault);
  return ok(await generatedText(model, localMessages(args, prompt), localTemperature(args), structuredSchema(args)));
}

const RUNTIME_TOOL_HANDLERS: Record<string, RuntimeToolHandler> = {
  mark_image: markImage,
  edit_file: editFile,
  edit_files: editFiles,
  write_file: writeFile,
  set_cells: setCells,
  save_link: saveLink,
  download_url: downloadUrl,
  list_scripts: listScripts,
  run_script: runScript,
  stt_status: sttStatusTool,
  retranscribe_file: retranscribe,
  read_recording: readRecording,
  run_skill_script: runSkillScript,
  start_file_pass: startFilePass,
  job_status: jobStatus,
  local_generate: localGenerate,
};

async function invokeLiveRuntimeTool(
  context: LiveRuntimeContext,
  name: string,
  args: Record<string, unknown>,
  effects: ToolEffects,
): Promise<ToolOutcome | null> {
  const room = context.state.room;
  if (!room) throw new Error("No room is open.");
  const workspaceHandler = WORKSPACE_TOOL_HANDLERS[name];
  if (workspaceHandler !== undefined) {
    if (room.workspace === undefined) return null;
    return workspaceHandler(context, room as WorkspaceLiveRoom, args, effects);
  }
  const handler = RUNTIME_TOOL_HANDLERS[name];
  return handler === undefined ? null : handler(context, room, args, effects);
}

interface FilePassJobPlan {
  fileId: string;
  fileName: string;
  instruction: string;
  mode: string;
}

interface FilePassRunResult {
  message: string;
  error: string | null;
}

function filePassPlanRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object") return {};
  if (value === null) return {};
  return value as Record<string, unknown>;
}

function filePassJobPlan(job: Job): FilePassJobPlan | null {
  const raw = filePassPlanRecord(job.plan);
  const fileId = str(raw.fileId);
  const fileName = str(raw.fileName);
  if (!fileId || !fileName) return null;
  return { fileId, fileName, instruction: str(raw.instruction), mode: str(raw.mode) || "merge" };
}

function roomDbForRunner(runner: JobRunnerDeps, roomPath: string) {
  const room = runner.rooms.current();
  return room?.path === roomPath ? room.db : null;
}

function recordFilePassStart(runner: JobRunnerDeps, jobId: string, roomPath: string): void {
  const db = roomDbForRunner(runner, roomPath);
  if (db) setJobStatus(db, jobId, "running", null);
}

function filePassError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function driveLiveFilePass(
  state: RoomManagerState,
  emit: EventSender,
  runner: JobRunnerDeps,
  job: Job,
  roomPath: string,
  plan: FilePassJobPlan,
  cancel: Parameters<RowStarter>[3],
): Promise<FilePassRunResult> {
  try {
    const result = await driveFilePass(
      {
        rooms: runner.rooms,
        emit,
        resolveEngine: async () => {
          const picked = await resolveLocalModel(state);
          return { model: picked.model, lane: picked.lane };
        },
      },
      job.id,
      roomPath,
      plan.fileId,
      plan.fileName,
      plan.instruction,
      plan.mode,
      cancel,
    );
    return { message: result.message, error: null };
  } catch (caught) {
    return { message: "", error: filePassError(caught) };
  }
}

function filePassJobStatus(error: string | null, paused: boolean): "done" | "paused" | "error" {
  if (error === null) return "done";
  return paused ? "paused" : "error";
}

function filePassProgress(jobId: string, result: FilePassRunResult, paused: boolean) {
  if (result.error === null) {
    return { jobId, label: result.message || "Full file pass ready", done: 1, total: 1, finished: true };
  }
  if (paused) return { jobId, label: "Paused", done: 0, total: 1, paused: true };
  return { jobId, label: `Stopped — ${result.error}`, done: 0, total: 1, failed: true };
}

async function finishLiveFilePass(
  runner: JobRunnerDeps,
  jobId: string,
  roomPath: string,
  cancel: Parameters<RowStarter>[3],
  result: FilePassRunResult,
): Promise<void> {
  const paused = cancel.load() || result.error === "STOPPED";
  const db = roomDbForRunner(runner, roomPath);
  if (db) setJobStatus(db, jobId, filePassJobStatus(result.error, paused), paused ? null : result.error);
  runner.removeCancelFlag(jobId);
  runner.sink.emit(filePassProgress(jobId, result, paused));
  await runner.onSettled(jobId);
}

async function runLiveFilePass(
  state: RoomManagerState,
  emit: EventSender,
  runner: JobRunnerDeps,
  job: Job,
  roomPath: string,
  plan: FilePassJobPlan,
  cancel: Parameters<RowStarter>[3],
): Promise<void> {
  recordFilePassStart(runner, job.id, roomPath);
  const result = await driveLiveFilePass(state, emit, runner, job, roomPath, plan, cancel);
  await finishLiveFilePass(runner, job.id, roomPath, cancel, result);
}

function createFilePassStarter(state: RoomManagerState, emit: EventSender): RowStarter {
  return async (jobQueue, job, roomPath, cancel) => {
    const plan = filePassJobPlan(job);
    if (!plan) return { kind: "error", message: "This file pass has an unreadable plan." };
    const runner = runnerDepsFrom(jobQueue);
    void spawnJobRunner(runner, job.id, roomPath, () => runLiveFilePass(state, emit, runner, job, roomPath, plan, cancel));
    return { kind: "runner" };
  };
}

export function createLiveRuntimeTool(options: LiveRuntimeToolOptions) {
  const { state, roomDeps, userDataDir, resourcesPath, emit } = options;
  const browserTool = createBrowserAgentTool({ state, roomDeps, browser: options.browser, agentUi: options.agentUi, emit });
  const sttBusy = new Map<string, string>();
  const passStarter = createFilePassStarter(state, emit);
  const queue = roomDeps.jobQueue;
  if (queue) {
    const starters = new Map(queue.starters);
    starters.set("rec_read", recReadRowStarter({
      resolvePassEngine: async () => {
        const picked = await resolveLocalModel(state);
        return { chatModel: picked.model, lane: picked.lane };
      },
      onReadDone: (event) => emit("rec-read-done", event),
    }));
    starters.set("file_pass", passStarter);
    roomDeps.jobQueue = { ...queue, starters };
  }

  const context: LiveRuntimeContext = {
    state,
    roomDeps,
    userDataDir,
    resourcesPath,
    emit,
    sttModelState: options.sttModelState,
    retranscribe: options.retranscribe,
    sttBusy,
  };
  return async (name: string, args: Record<string, unknown>, effects: ToolEffects): Promise<ToolOutcome | null> => {
    const browsed = await browserTool(name, args, effects);
    if (browsed !== null) return browsed;
    try {
      return await invokeLiveRuntimeTool(context, name, args, effects);
    } catch (error) {
      return fail(error);
    }
  };
}
