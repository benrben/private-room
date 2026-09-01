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

import { MAX_SHOT_RUN, CreatePlan, StudioPlan, ensureQueue, record, str, optStr, stringList, errorMessage, roomOrThrow, setStarter } from "./creativeJobSurfaceShared.js";
import { startDeepSummaryJob, rejectDuringRollback, rejectWhenQueueIsFull, studioFactories, studioStarter, podcastStarter, deepSummaryStarter } from "./creativeJobSurfaceSummary.js";
import { createStarter, makeCreateJob, PlannedRow, planShotList } from "./creativeJobSurfaceCreate.js";

export function installCreativeJobStarters(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  emit: EventSender,
): JobQueueDeps {
  const queue = ensureQueue(state, deps, emit);
  setStarter(queue, "studio", studioStarter(state, emit));
  setStarter(queue, "podcast_audio", podcastStarter(state, emit));
  setStarter(queue, "deep_summary", deepSummaryStarter(state, emit));
  setStarter(queue, "create", createStarter(state, emit));
  return queue;
}

export function registerCreativeJobSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  deps: RoomManagerDeps,
  emit: EventSender,
): void {
  const queue = installCreativeJobStarters(state, deps, emit);
  ipcMain.handle("start_deep_summary", () => startDeepSummaryJob(state, deps, false));
  ipcMain.handle("start_studio_job", (_event: IpcMainInvokeEvent, raw: unknown) => startStudioJob(state, queue, raw));
  ipcMain.handle("start_podcast_audio_job", (_event: IpcMainInvokeEvent, raw: unknown) => startPodcastAudioJob(state, queue, raw));
  ipcMain.handle("start_create_job", (_event: IpcMainInvokeEvent, raw: unknown) => makeCreateJob(state, deps, emit, createPlanFromRaw(raw), false));
  ipcMain.handle("story_film_plan", (_event: IpcMainInvokeEvent, raw: unknown) => storyFilmPlan(state, raw));
  ipcMain.handle("start_shot_list_job", (_event: IpcMainInvokeEvent, raw: unknown) => startShotListJob(state, deps, emit, raw));
}

export function studioPlanFromRaw(raw: unknown): StudioPlan {
  const args = record(raw);
  return {
    kind: str(args.kind),
    scope: typeof args.scope === "string" ? args.scope : null,
    instructions: typeof args.instructions === "string" ? args.instructions : null,
    refs: Array.isArray(args.refs) ? stringList(args.refs) : null,
  };
}

export async function startStudioJob(state: RoomManagerState, queue: JobQueueDeps, raw: unknown): Promise<string> {
  rejectDuringRollback(state);
  const plan = studioPlanFromRaw(raw);
  assertStudioKind(plan.kind);
  const room = roomOrThrow(state);
  rejectWhenQueueIsFull(room.conn);
  const id = createJob(room.conn, "studio", studioTitle(plan.kind), plan, 0);
  await submit(queue, id);
  return id;
}

export function assertStudioKind(kind: string): void {
  if (studioSpecFor(kind, studioFactories()) === null) throw new Error("Unknown studio kind.");
}

export async function startPodcastAudioJob(state: RoomManagerState, queue: JobQueueDeps, raw: unknown): Promise<string> {
  const scriptFileId = str(record(raw).scriptFileId);
  const room = roomOrThrow(state);
  const podcast = getPodcast(room.conn, scriptFileId);
  assertPodcastReady(podcast);
  rejectWhenQueueIsFull(room.conn);
  const id = createJob(room.conn, "podcast_audio", "Podcast episode", { scriptFileId }, 1);
  await submit(queue, id);
  return id;
}

export function assertPodcastReady(podcast: ReturnType<typeof getPodcast>): void {
  if (podcast === null) throw new Error("This file has no podcast script attached. Scripts made before voices existed have to be generated again before they can be recorded.");
  if (podcast.turns.length === 0) throw new Error("This script has no lines to read.");
}

export function createPlanFromRaw(raw: unknown): CreatePlan {
  const args = record(raw);
  return {
    prompt: str(args.prompt), model: str(args.model), kind: args.kind === "video" ? "video" : "image",
    variations: typeof args.variations === "number" ? args.variations : 1,
    seconds: typeof args.seconds === "number" ? Math.trunc(args.seconds) : null,
    resolution: str(args.resolution), aspectRatio: str(args.aspectRatio), referenceFileIds: stringList(args.referenceFileIds),
    frameFileId: optStr(args.frameFileId), lastFrameFileId: null, chained: false,
    referencesAck: args.referencesAck === true, shotId: optStr(args.shotId),
  };
}

export function filmPlanRequest(raw: unknown): { listId: string; kind: CreatePlan["kind"]; continuous: boolean } {
  const args = record(raw);
  return { listId: str(args.listId), kind: args.kind === "video" ? "video" : "image", continuous: args.continuous !== false };
}

export function storyFilmPlan(state: RoomManagerState, raw: unknown): FilmPlan {
  const request = filmPlanRequest(raw);
  const rows = planShotList(roomOrThrow(state).conn, request.listId, request.kind, request.continuous);
  return filmPlanFromRows(request.kind, rows);
}

export function filmPlanFromRows(kind: CreatePlan["kind"], rows: PlannedRow[]): FilmPlan {
  const active = rows.filter((row) => row.plan !== null);
  return {
    kind, shots: rows.map((row) => row.preview), sending: active.length, skipped: rows.length - active.length,
    totalSeconds: totalFilmSeconds(active), joined: joinedFilmShots(rows), overCap: active.length > MAX_SHOT_RUN,
    joinBlockedBy: firstDroppedJoin(rows), faceless: facelessCast(active),
  };
}

export function totalFilmSeconds(rows: PlannedRow[]): number {
  return rows.reduce((total, row) => total + (row.plan?.seconds ?? 0), 0);
}

export function joinedFilmShots(rows: PlannedRow[]): number {
  return rows.filter((row) => row.preview.startsOnPrevious).length;
}

export function firstDroppedJoin(rows: PlannedRow[]): string | null {
  return rows.find((row) => row.preview.joinDropped !== null)?.preview.joinDropped ?? null;
}

export function facelessCast(rows: PlannedRow[]): string[] {
  return [...new Set(rows.flatMap((row) => row.preview.faceless))];
}

export async function startShotListJob(state: RoomManagerState, deps: RoomManagerDeps, emit: EventSender, raw: unknown): Promise<ShotRunStarted> {
  const request = filmPlanRequest(raw);
  const room = roomOrThrow(state);
  const plannedRoom = room.path;
  const plans = actionableShotPlans(planShotList(room.conn, request.listId, request.kind, request.continuous));
  assertShotPlansAvailable(plans, request.kind);
  assertShotPlanLimit(plans.length);
  const started = await submitShotPlans(state, deps, emit, plans, plannedRoom);
  return shotRunStarted(started, plans.length);
}

export function actionableShotPlans(rows: PlannedRow[]): CreatePlan[] {
  return rows.flatMap((row) => row.plan === null ? [] : [row.plan]);
}

export function assertShotPlansAvailable(plans: CreatePlan[], kind: CreatePlan["kind"]): void {
  if (plans.length > 0) return;
  throw new Error(kind === "video" ? "Nothing to film — every shot either has a clip already or has no video model chosen." : "Nothing to draw — every shot either has a picture already or has no picture model chosen.");
}

export function assertShotPlanLimit(count: number): void {
  if (count <= MAX_SHOT_RUN) return;
  throw new Error(`That is ${count} generations in one go, and this room will queue ${MAX_SHOT_RUN} at a time.`);
}

export async function submitShotPlans(
  state: RoomManagerState, deps: RoomManagerDeps, emit: EventSender, plans: CreatePlan[], plannedRoom: string,
): Promise<{ jobIds: string[]; failure: string | null }> {
  const jobIds: string[] = [];
  for (const plan of plans) {
    const failure = await submitShotPlan(state, deps, emit, plan, plannedRoom, jobIds);
    if (failure !== null) return { jobIds, failure };
  }
  return { jobIds, failure: null };
}

export async function submitShotPlan(
  state: RoomManagerState, deps: RoomManagerDeps, emit: EventSender, plan: CreatePlan, plannedRoom: string, jobIds: string[],
): Promise<string | null> {
  if (state.room?.path !== plannedRoom) return "the room changed while these were being queued";
  try {
    jobIds.push(await makeCreateJob(state, deps, emit, plan, true));
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

export function shotRunStarted(started: { jobIds: string[]; failure: string | null }, asked: number): ShotRunStarted {
  if (started.jobIds.length === 0) throw new Error(started.failure ?? "nothing could be started");
  return {
    jobIds: started.jobIds,
    asked,
    shortfall: shotRunShortfall(started.jobIds.length, asked, started.failure),
  };
}

export function shotRunShortfall(started: number, asked: number, failure: string | null): string | null {
  if (started === asked) return null;
  return `Only ${started} of ${asked} could be started — ${failure ?? "the room stopped accepting them"}`;
}
