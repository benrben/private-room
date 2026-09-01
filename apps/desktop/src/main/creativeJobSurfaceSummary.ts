import type { IpcMain, IpcMainInvokeEvent } from "electron";
import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag } from "./cancel.js";
import { runsOnThisMac } from "./capabilities.js";
import { modelSetting } from "./gatherContext.js";
import { listModels } from "./engineRouting.js";
import { bestLocalDefault } from "./ollamaModels.js";
import {
  createJob,
  getJob,
  setJobStatus,
  checkpointJob,
  unfinishedJobs,
} from "./db-host/jobs.js";
import {
  getFileExtractedText,
  getFileMeta,
  listFilesForSummary,
  filesMissingSummary,
  markSectionOnly,
  setFileAiSummary,
} from "./db-host/files.js";
import {
  castFaces,
  listCast,
  listShots,
  listStoryLists,
  setShotResult,
} from "./db-host/story.js";
import { webAccessEnabled } from "./browser/webAccess.js";
import { atCapacity, createJobQueueState, defaultRowStarters, QUEUE_FULL, runnerDepsFrom, submit, type JobQueueDeps, type RowStarter } from "./jobQueue.js";
import {
  emitProgress,
  pinnedDb,
  runPlan,
  spawnJobRunner,
  spawnPodcastAudio,
  type RoomHandle,
  type ProgressSink,
  type Step,
  type StepResult,
} from "./jobs.js";
import { isSummaryFile, MAX_SUMMARY_FILES, summarizeOneFile, writeRoomSummary } from "./summarizeTools.js";
import { flashcardsSpec } from "./studiosFlashcards.js";
import { mindmapSpec } from "./studiosMindmap.js";
import { podcastSpec } from "./studiosPodcast.js";
import { runStudioCore, studioSpecFor, studioTitle } from "./studiosCmds.js";
import { getPodcast, renderPodcastAudio } from "./studiosPodcastAudio.js";
import { limitsFor, allowsSeconds, defaultSeconds, takesFirstFrame } from "./mediaLimits.js";
import { ensureProviderCatalog, injectProviderRuntime, providerModelFacts } from "./providers.js";
import { injectPolicy } from "./privacy.js";
import { sidecarJsonCancellable } from "./sidecarJsonCancellable.js";
import { shotPrompt } from "./storyTools.js";
import type { FilmPlan, ShotPreview, ShotRunStarted } from "../shared/apiTypes.js";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";
import { createRoomFile, readRoomFile } from "./workspace/roomContent.js";

import { StudioPlan, record, optStr, stringList, errorMessage, roomOrThrow, queueOrThrow, ensureQueue, roomSource, setStarter } from "./creativeJobSurfaceShared.js";

export async function startDeepSummaryJob(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  auto: boolean,
): Promise<string> {
  rejectDuringRollback(state);
  const queue = queueOrThrow(deps);
  const room = roomOrThrow(state);
  const roomPath = room.path;
  rejectWhenQueueIsFull(room.conn);
  const files = summaryFiles(room.conn, auto);
  rejectWhenNoSummaryFiles(files.length, auto);
  const model = await resolveSummaryModel(room.conn);
  const currentRoom = summaryRoomAtPath(state, roomPath);
  const id = createSummaryJob(currentRoom.conn, files, model, auto);
  await submit(queue, id);
  return id;
}

export function rejectDuringRollback(state: RoomManagerState): void {
  if (state.rollingBack) throw new Error("A room rollback is in progress — try again when it finishes.");
}

export function rejectWhenQueueIsFull(db: Database.Database): void {
  if (atCapacity(db)) throw new Error(QUEUE_FULL);
}

export function summaryFiles(db: Database.Database, auto: boolean): { id: string }[] {
  if (auto) return filesMissingSummary(db, MAX_SUMMARY_FILES).map(([id]) => ({ id }));
  return listFilesForSummary(db)
    .filter((file) => !isSummaryFile(file.name, file.source))
    .slice(0, MAX_SUMMARY_FILES);
}

export function rejectWhenNoSummaryFiles(count: number, auto: boolean): void {
  if (count > 0) return;
  throw new Error(auto ? "There are no new files to index." : "This room has no files to summarize yet.");
}

export function summaryRoomAtPath(state: RoomManagerState, roomPath: string): NonNullable<RoomManagerState["room"]> {
  if (state.room === null || state.room.path !== roomPath) {
    throw new Error("The room changed while the summary was starting.");
  }
  return state.room;
}

export function createSummaryJob(
  db: Database.Database,
  files: { id: string }[],
  model: string,
  auto: boolean,
): string {
  return createJob(
    db,
    "deep_summary",
    auto ? "Indexing new files" : "Room summary",
    { fileIds: files.map((file) => file.id), model, auto, reduce: !auto },
    files.length,
  );
}
export function studioFactories() {
  return { flashcards: flashcardsSpec, mindmap: mindmapSpec, podcast: podcastSpec };
}

export function parseStudioPlan(v: unknown): StudioPlan | null {
  const o = record(v);
  if (typeof o.kind !== "string") return null;
  return {
    kind: o.kind,
    scope: typeof o.scope === "string" ? o.scope : null,
    instructions: typeof o.instructions === "string" ? o.instructions : null,
    refs: Array.isArray(o.refs) ? stringList(o.refs) : null,
  };
}

export function studioStarter(state: RoomManagerState, emit: EventSender): RowStarter {
  return async (queue, job, roomPath, cancel) => {
    const plan = parseStudioPlan(job.plan);
    if (plan === null) return { kind: "error", message: "This job's plan is unreadable." };
    const spec = studioSpecFor(plan.kind, studioFactories());
    if (spec === null) return { kind: "error", message: `Unknown studio kind '${plan.kind}'.` };
    const runner = runnerDepsFrom(queue);
    void spawnJobRunner(runner, job.id, roomPath, () => runStudioJob(state, emit, runner, job.id, roomPath, plan, spec, cancel));
    return { kind: "runner" };
  };
}

export async function runStudioJob(
  state: RoomManagerState,
  emit: EventSender,
  runner: ReturnType<typeof runnerDepsFrom>,
  jobId: string,
  roomPath: string,
  plan: StudioPlan,
  spec: NonNullable<ReturnType<typeof studioSpecFor>>,
  cancel: CancelFlag,
): Promise<void> {
  setRunning(runner, jobId, roomPath);
  emitProgress(runner.sink, jobId, "Starting…", 0, 0);
  const result = await runStudioResult(state, emit, plan, spec, cancel, roomPath);
  settleStudioJob(runner, jobId, roomPath, plan.kind, cancel, result);
  await runner.onSettled(jobId);
}

export function setRunning(runner: ReturnType<typeof runnerDepsFrom>, jobId: string, roomPath: string): void {
  const db = pinnedDb(runner.rooms, roomPath);
  if (db !== null) setJobStatus(db, jobId, "running", null);
}

export async function runStudioResult(
  state: RoomManagerState,
  emit: EventSender,
  plan: StudioPlan,
  spec: NonNullable<ReturnType<typeof studioSpecFor>>,
  cancel: CancelFlag,
  roomPath: string,
): Promise<{ fileId: string | null; failure: string | null }> {
  try {
    const output = await runStudioCore(
      { rooms: roomSource(state), cancelState: state.cancel, emit }, spec,
      plan.scope, plan.instructions, plan.refs, cancel, roomPath,
    );
    return { fileId: output.id, failure: null };
  } catch (error) {
    return { fileId: null, failure: errorMessage(error) };
  }
}

export function settleStudioJob(
  runner: ReturnType<typeof runnerDepsFrom>,
  jobId: string,
  roomPath: string,
  kind: string,
  cancel: CancelFlag,
  result: { fileId: string | null; failure: string | null },
): void {
  const paused = cancel.load();
  updateStudioStatus(runner, jobId, roomPath, result.fileId, result.failure, paused);
  runner.removeCancelFlag(jobId);
  runner.sink.emit(studioCompletion(jobId, kind, result.fileId, result.failure, paused));
}

export function updateStudioStatus(
  runner: ReturnType<typeof runnerDepsFrom>, jobId: string, roomPath: string,
  fileId: string | null, failure: string | null, paused: boolean,
): void {
  const db = pinnedDb(runner.rooms, roomPath);
  if (db === null) return;
  setJobStatus(db, jobId, fileId !== null ? "done" : paused ? "paused" : "error", fileId !== null || paused ? null : failure);
}

export function studioCompletion(jobId: string, kind: string, fileId: string | null, failure: string | null, paused: boolean) {
  if (fileId !== null) return { jobId, label: `${studioTitle(kind)} ready`, done: 1, total: 1, finished: true, fileId };
  if (paused) return { jobId, label: "Paused", done: 0, total: 1, paused: true };
  return { jobId, label: `Stopped — ${failure ?? "unknown error"}`, done: 0, total: 1, failed: true };
}

export function podcastStarter(state: RoomManagerState, emit: EventSender): RowStarter {
  return async (queue, job, roomPath, cancel) => {
    const scriptFileId = optStr(record(job.plan).scriptFileId);
    if (scriptFileId === null) return { kind: "error", message: "This job's plan is unreadable." };
    const runner = runnerDepsFrom(queue);
    void spawnPodcastAudio(
      {
        ...runner,
        render: (id, flag) => renderPodcastAudio(roomSource(state), id, flag, roomPath, {
          emit: (payload) => emit("studio-step", payload),
          filesChanged: () => emit("room-files-changed", undefined),
        }),
      }, job.id, roomPath, scriptFileId, cancel,
    );
    return { kind: "runner" };
  };
}

export async function resolveSummaryModel(db: Database.Database): Promise<string> {
  const configured = modelSetting(db);
  if (configured !== null && configured.trim() !== "") return configured;
  return bestLocalDefault(await listModels());
}

export function deepSummaryStarter(state: RoomManagerState, emit: EventSender): RowStarter {
  return async (queue, job, roomPath, cancel) => {
    const plan = record(job.plan);
    const fileIds = stringList(plan.fileIds);
    const model = optStr(plan.model);
    if (fileIds.length === 0 || model === null) return { kind: "error", message: "This job's plan is unreadable." };
    const runner = runnerDepsFrom(queue);
    void spawnJobRunner(runner, job.id, roomPath, () => runDeepSummaryJob(
      state, emit, runner, job.id, roomPath, fileIds, model, plan.auto === true, plan.reduce !== false, job.cursor, cancel,
    ));
    return { kind: "runner" };
  };
}

export function summarySteps(fileIds: string[], model: string): Step[] {
  const lane = runsOnThisMac(model) ? "local_llm" : "cloud";
  return fileIds.map((_, id) => ({ id, lane, kind: "summarize_file", params: null, dependsOn: [] }));
}

export function initialSummaryCursor(cursor: number, count: number): number {
  return Math.max(0, Math.min(cursor, count));
}

export async function runDeepSummaryJob(
  state: RoomManagerState,
  emit: EventSender,
  runner: ReturnType<typeof runnerDepsFrom>,
  jobId: string,
  roomPath: string,
  fileIds: string[],
  model: string,
  auto: boolean,
  reduce: boolean,
  initialCursor: number,
  cancel: CancelFlag,
): Promise<void> {
  setRunning(runner, jobId, roomPath);
  const steps = summarySteps(fileIds, model);
  let cursor = initialSummaryCursor(initialCursor, steps.length);
  const outcome = await runSummaryPlan(state, runner, jobId, roomPath, fileIds, model, auto, steps, cursor, cancel, (next) => {
    cursor = next;
  });
  const reduced = await reduceSummary(state, emit, runner, jobId, roomPath, model, steps.length, outcome, reduce, cancel);
  finishDeepSummary(runner, jobId, roomPath, auto, steps.length, cursor, reduced);
  await runner.onSettled(jobId);
}

export async function runSummaryPlan(
  state: RoomManagerState,
  runner: ReturnType<typeof runnerDepsFrom>,
  jobId: string,
  roomPath: string,
  fileIds: string[],
  model: string,
  auto: boolean,
  steps: Step[],
  cursor: number,
  cancel: CancelFlag,
  updateCursor: (cursor: number) => void,
) {
  return runPlan(
    steps,
    new Set(Array.from({ length: cursor }, (_, index) => index)),
    cancel,
    (step) => summarizeStep(runner, roomPath, fileIds, model, auto, step),
    (done) => checkpointSummaryProgress(runner, jobId, roomPath, done, updateCursor),
    (done, total) => emitSummaryProgress(runner, jobId, done, total, auto),
  );
}

export async function summarizeStep(
  runner: ReturnType<typeof runnerDepsFrom>,
  roomPath: string,
  fileIds: string[],
  model: string,
  auto: boolean,
  step: Step,
): Promise<StepResult> {
  const db = pinnedDb(runner.rooms, roomPath);
  if (db === null) return { ok: false, error: "the room this job belongs to was closed" };
  const id = fileIds[step.id];
  if (id === undefined) return { ok: false, error: "This job's plan is unreadable." };
  const meta = getFileMeta(db, id);
  const text = getFileExtractedText(db, id);
  if (meta.aiSummary?.trim()) return { ok: true };
  if (text === null || text.trim() === "") return { ok: true };
  return summarizeAndStore(runner, roomPath, model, meta, id, text, auto);
}

export async function summarizeAndStore(
  runner: ReturnType<typeof runnerDepsFrom>,
  roomPath: string,
  model: string,
  meta: ReturnType<typeof getFileMeta>,
  id: string,
  text: string,
  auto: boolean,
): Promise<StepResult> {
  try {
    const liner = await summarizeOneFile(model, meta.name, meta.mimeType, text, "30m");
    storeSummaryLiner(runner, roomPath, id, liner, auto);
    return { ok: true };
  } catch (error) {
    return summaryFailure(error);
  }
}

export function storeSummaryLiner(
  runner: ReturnType<typeof runnerDepsFrom>, roomPath: string, id: string, liner: string, auto: boolean,
): void {
  const db = pinnedDb(runner.rooms, roomPath);
  if (db !== null && (liner.trim() !== "" || auto)) setFileAiSummary(db, id, liner);
}

export function summaryFailure(error: unknown): StepResult {
  const message = errorMessage(error);
  if (message === "OLLAMA_DOWN" || message.startsWith("MODEL_MISSING")) return { ok: false, error: message };
  return { ok: true };
}

export function checkpointSummaryProgress(
  runner: ReturnType<typeof runnerDepsFrom>, jobId: string, roomPath: string, done: ReadonlySet<number>, updateCursor: (cursor: number) => void,
): void {
  const cursor = completedCursor(done);
  updateCursor(cursor);
  const db = pinnedDb(runner.rooms, roomPath);
  if (db !== null) checkpointJob(db, jobId, cursor, {});
}

export function completedCursor(done: ReadonlySet<number>): number {
  let cursor = 0;
  while (done.has(cursor)) cursor += 1;
  return cursor;
}

export function emitSummaryProgress(runner: ReturnType<typeof runnerDepsFrom>, jobId: string, done: number, total: number, auto: boolean): void {
  emitProgress(runner.sink, jobId, summaryProgressLabel(done, total, auto), done, total);
}

export function summaryProgressLabel(done: number, total: number, auto: boolean): string {
  if (done >= total) return "Finishing…";
  return `${auto ? "Indexing" : "Summarizing"} file ${done + 1} of ${total}…`;
}

export async function reduceSummary(
  state: RoomManagerState,
  emit: EventSender,
  runner: ReturnType<typeof runnerDepsFrom>,
  jobId: string,
  roomPath: string,
  model: string,
  total: number,
  outcome: Awaited<ReturnType<typeof runPlan>>,
  reduce: boolean,
  cancel: CancelFlag,
): Promise<{ final: Awaited<ReturnType<typeof runPlan>>; fileId: string | undefined }> {
  if (outcome.kind !== "done") return { final: outcome, fileId: undefined };
  if (cancel.load()) return { final: { kind: "paused" }, fileId: undefined };
  if (!reduce) return { final: outcome, fileId: undefined };
  try {
    emitProgress(runner.sink, jobId, "Writing the summary…", total, total);
    const fileId = (await writeRoomSummary(roomSource(state), model, roomPath, { emit })).id;
    return { final: outcome, fileId };
  } catch (error) {
    return { final: { kind: "error", error: errorMessage(error) }, fileId: undefined };
  }
}

export function finishDeepSummary(
  runner: ReturnType<typeof runnerDepsFrom>, jobId: string, roomPath: string, auto: boolean,
  total: number, cursor: number, result: { final: Awaited<ReturnType<typeof runPlan>>; fileId: string | undefined },
): void {
  updateDeepSummaryStatus(runner, jobId, roomPath, result.final);
  runner.removeCancelFlag(jobId);
  runner.sink.emit(deepSummaryCompletion(jobId, auto, total, cursor, result));
}

export function updateDeepSummaryStatus(
  runner: ReturnType<typeof runnerDepsFrom>, jobId: string, roomPath: string, final: Awaited<ReturnType<typeof runPlan>>,
): void {
  const db = pinnedDb(runner.rooms, roomPath);
  if (db === null) return;
  setJobStatus(db, jobId, final.kind === "done" ? "done" : final.kind === "paused" ? "paused" : "error", final.kind === "error" ? final.error : null);
}

export function deepSummaryCompletion(
  jobId: string, auto: boolean, total: number, cursor: number,
  result: { final: Awaited<ReturnType<typeof runPlan>>; fileId: string | undefined },
) {
  if (result.final.kind === "done") return {
    jobId, label: auto ? "Indexing finished" : "Summary ready", done: total, total, finished: true,
    ...(result.fileId !== undefined && !auto ? { fileId: result.fileId } : {}),
  };
  if (result.final.kind === "paused") return { jobId, label: "Paused", done: cursor, total, paused: true };
  return { jobId, label: `Stopped — ${result.final.error}`, done: cursor, total, failed: true };
}
