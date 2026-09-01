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

import { MAX_VARIATIONS, VIDEO_POLL_MS, VIDEO_CEILING_MS, CreatePlan, record, str, optStr, errorMessage, sleep, roomOrThrow, ensureQueue } from "./creativeJobSurfaceShared.js";
import { rejectDuringRollback, setRunning } from "./creativeJobSurfaceSummary.js";

export async function creativeAttachment(
  room: RoomHandle,
  id: string,
): Promise<{ b64: string; mime: string }> {
  const bytes = (await readRoomFile(room, id)).bytes;
  if (bytes === null) throw new Error("That reference file has no saved bytes.");
  return { b64: bytes.toString("base64"), mime: getFileMeta(room.db, id).mimeType };
}

export async function storeCreativeOutput(
  room: RoomHandle,
  name: string,
  mime: string,
  bytes: Uint8Array,
  text: string,
) {
  return createRoomFile(room, name, mime, bytes, text, "generated");
}

export async function postMedia(path: string, body: Record<string, unknown>, model: string, cancel: CancelFlag, timeout?: number): Promise<Record<string, unknown>> {
  await ensureProviderCatalog(model);
  const policy = injectPolicy(body) ?? body;
  const wire = injectProviderRuntime(policy, model);
  const outcome = await sidecarJsonCancellable(path, wire, cancel, timeout);
  if (outcome.kind === "stopped") throw new Error("stopped");
  if (outcome.kind === "error") throw new Error(outcome.error.error);
  return record(outcome.value);
}

export function validateCreatePlan(plan: CreatePlan): void {
  plan.prompt = plan.prompt.trim();
  assertCreateKind(plan.kind);
  assertCreatePrompt(plan);
  plan.variations = normalizedVariations(plan.variations);
  const slug = providerSlug(plan.model);
  const limits = limitsFor(slug);
  if (limits !== undefined) applyCreateLimits(plan, slug, limits);
  clearImageSeconds(plan);
}

export function assertCreateKind(kind: string): asserts kind is CreatePlan["kind"] {
  if (kind !== "image" && kind !== "video") throw new Error("Unknown thing to make.");
}

export function assertCreatePrompt(plan: CreatePlan): void {
  if (plan.prompt !== "") return;
  if (plan.kind === "video" && plan.frameFileId !== null) return;
  throw new Error("Say what to make first.");
}

export function normalizedVariations(value: number): number {
  return Math.max(1, Math.min(MAX_VARIATIONS, Math.trunc(value || 1)));
}

export function providerSlug(model: string): string {
  if (!model.includes("::")) return model;
  return model.split("::").slice(1).join("::");
}

export function applyCreateLimits(plan: CreatePlan, slug: string, limits: NonNullable<ReturnType<typeof limitsFor>>): void {
  limitReferences(plan, limits.maxReferences);
  clearUnsupportedAspectRatio(plan, limits.aspectRatios);
  clearUnsupportedResolution(plan, limits.resolutions);
  if (plan.kind === "video") applyVideoLimits(plan, slug, limits);
}

export function limitReferences(plan: CreatePlan, maximum: number | null | undefined): void {
  plan.referenceFileIds = plan.referenceFileIds.slice(0, maximum ?? plan.referenceFileIds.length);
}

export function clearUnsupportedAspectRatio(plan: CreatePlan, allowed: string[]): void {
  if (plan.aspectRatio === "" || allowed.length === 0) return;
  if (!allowed.includes(plan.aspectRatio)) plan.aspectRatio = "";
}

export function clearUnsupportedResolution(plan: CreatePlan, allowed: string[]): void {
  if (plan.resolution === "" || allowed.length === 0) return;
  if (!allowed.includes(plan.resolution)) plan.resolution = "";
}

export function applyVideoLimits(plan: CreatePlan, slug: string, limits: NonNullable<ReturnType<typeof limitsFor>>): void {
  assertFirstFrameSupported(plan, slug, limits);
  clearUnsupportedLastFrame(plan, limits);
  validateVideoSeconds(plan, slug, limits);
  setDefaultSeconds(plan, limits);
}

export function assertFirstFrameSupported(plan: CreatePlan, slug: string, limits: NonNullable<ReturnType<typeof limitsFor>>): void {
  if (plan.frameFileId !== null && !takesFirstFrame(limits)) throw new Error(`${slug} cannot start from a picture.`);
}

export function clearUnsupportedLastFrame(plan: CreatePlan, limits: NonNullable<ReturnType<typeof limitsFor>>): void {
  if (plan.lastFrameFileId !== null && !limits.frameImages.includes("last_frame")) plan.lastFrameFileId = null;
}

export function validateVideoSeconds(plan: CreatePlan, slug: string, limits: NonNullable<ReturnType<typeof limitsFor>>): void {
  if (plan.seconds !== null && !allowsSeconds(limits, plan.seconds)) throw new Error(`${slug} does not make ${plan.seconds}-second clips.`);
}

export function setDefaultSeconds(plan: CreatePlan, limits: NonNullable<ReturnType<typeof limitsFor>>): void {
  if (plan.seconds === null) plan.seconds = defaultSeconds(limits);
}

export function clearImageSeconds(plan: CreatePlan): void {
  if (plan.kind === "image") plan.seconds = null;
}

export async function ensureCanGenerate(plan: CreatePlan): Promise<void> {
  await ensureProviderCatalog(plan.model);
  const facts = providerModelFacts(plan.model);
  const yes = plan.kind === "image" ? facts?.imageOutput : facts?.videoOutput;
  if (yes !== true) throw new Error(`The selected model cannot make ${plan.kind === "image" ? "pictures" : "clips"}. Pick a model from the Create page.`);
}

export function artworkName(prompt: string, index: number, count: number, ext: string): string {
  const words = prompt.trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ") || "Creation";
  const safe = words.replace(/[\\/:*?"<>|]/g, "-").slice(0, 70);
  return `${safe}${count > 1 ? ` ${index + 1}` : ""}.${ext}`;
}

export async function runCreate(state: RoomManagerState, emit: EventSender, queue: JobQueueDeps, jobId: string, roomPath: string, plan: CreatePlan, cancel: CancelFlag): Promise<void> {
  const runner = runnerDepsFrom(queue);
  await spawnJobRunner(runner, jobId, roomPath, () => runCreateJob(emit, runner, jobId, roomPath, plan, cancel));
}

export type CreativeAttachment = Awaited<ReturnType<typeof creativeAttachment>>;

export async function runCreateJob(
  emit: EventSender,
  runner: ReturnType<typeof runnerDepsFrom>,
  jobId: string,
  roomPath: string,
  plan: CreatePlan,
  cancel: CancelFlag,
): Promise<void> {
  setRunning(runner, jobId, roomPath);
  const result = await makeCreations(emit, runner, jobId, roomPath, plan, cancel);
  settleCreateJob(runner, jobId, roomPath, result, cancel);
  await runner.onSettled(jobId);
}

export async function makeCreations(
  emit: EventSender, runner: ReturnType<typeof runnerDepsFrom>, jobId: string, roomPath: string, plan: CreatePlan, cancel: CancelFlag,
): Promise<{ made: string[]; failure: string | null }> {
  const made: string[] = [];
  try {
    const attachments = await loadCreateAttachments(runner, roomPath, plan);
    await createVariations(emit, runner, jobId, roomPath, plan, attachments, cancel, made);
    return { made, failure: null };
  } catch (error) {
    return { made, failure: errorMessage(error) };
  }
}

export function roomForCreate(runner: ReturnType<typeof runnerDepsFrom>, roomPath: string, message: string): RoomHandle {
  const room = runner.rooms.current();
  if (room === null || room.path !== roomPath) throw new Error(message);
  return room;
}

export async function loadCreateAttachments(
  runner: ReturnType<typeof runnerDepsFrom>, roomPath: string, plan: CreatePlan,
): Promise<{ refs: CreativeAttachment[]; frame: CreativeAttachment | null; tail: CreativeAttachment | null }> {
  const room = roomForCreate(runner, roomPath, "the room this job belongs to was closed");
  const refs = await Promise.all(plan.referenceFileIds.map((id) => creativeAttachment(room, id)));
  const frame = await optionalAttachment(room, plan.frameFileId);
  const tail = await optionalAttachment(room, plan.lastFrameFileId);
  return { refs, frame, tail };
}

export async function optionalAttachment(room: RoomHandle, id: string | null): Promise<CreativeAttachment | null> {
  if (id === null) return null;
  return creativeAttachment(room, id);
}

export async function createVariations(
  emit: EventSender,
  runner: ReturnType<typeof runnerDepsFrom>,
  jobId: string,
  roomPath: string,
  plan: CreatePlan,
  attachments: { refs: CreativeAttachment[]; frame: CreativeAttachment | null; tail: CreativeAttachment | null },
  cancel: CancelFlag,
  made: string[],
): Promise<void> {
  for (let index = 0; index < plan.variations && !cancel.load(); index += 1) {
    const fileId = await createVariation(emit, runner, jobId, roomPath, plan, attachments, cancel, index);
    if (fileId !== null) made.push(fileId);
  }
}

export async function createVariation(
  emit: EventSender,
  runner: ReturnType<typeof runnerDepsFrom>,
  jobId: string,
  roomPath: string,
  plan: CreatePlan,
  attachments: { refs: CreativeAttachment[]; frame: CreativeAttachment | null; tail: CreativeAttachment | null },
  cancel: CancelFlag,
  index: number,
): Promise<string | null> {
  const done = Math.floor(index * 100 / plan.variations);
  emitProgress(runner.sink, jobId, createProgressLabel(plan.kind), done, 100);
  const reply = await generateCreation(runner, jobId, plan, attachments, cancel, done);
  if (cancel.load()) return null;
  return persistCreation(emit, runner, roomPath, plan, reply, index);
}

export function createProgressLabel(kind: CreatePlan["kind"]): string {
  return kind === "video" ? "Filming…" : "Painting…";
}

export async function generateCreation(
  runner: ReturnType<typeof runnerDepsFrom>, jobId: string, plan: CreatePlan,
  attachments: { refs: CreativeAttachment[]; frame: CreativeAttachment | null; tail: CreativeAttachment | null }, cancel: CancelFlag, done: number,
): Promise<Record<string, unknown>> {
  if (plan.kind === "image") return generateImage(plan, attachments.refs, cancel);
  return generateVideo(runner, jobId, plan, attachments, cancel, done);
}

export function generateImage(plan: CreatePlan, refs: CreativeAttachment[], cancel: CancelFlag): Promise<Record<string, unknown>> {
  return postMedia("/image_generate", {
    model: plan.model, prompt: plan.prompt, kind: plan.kind,
    reference_b64: refs.map((ref) => ref.b64), reference_mime: refs.map((ref) => ref.mime),
    references_ack: plan.referencesAck, aspect_ratio: plan.aspectRatio, resolution: plan.resolution,
  }, plan.model, cancel);
}

export async function generateVideo(
  runner: ReturnType<typeof runnerDepsFrom>, jobId: string, plan: CreatePlan,
  attachments: { refs: CreativeAttachment[]; frame: CreativeAttachment | null; tail: CreativeAttachment | null }, cancel: CancelFlag, done: number,
): Promise<Record<string, unknown>> {
  const videoId = await startVideo(plan, attachments, cancel);
  await waitForVideo(runner, jobId, plan.model, videoId, cancel, done);
  emitProgress(runner.sink, jobId, "Downloading the clip…", done, 100);
  return postMedia("/video_fetch", { model: plan.model, video_id: videoId }, plan.model, cancel, 600_000);
}

export async function startVideo(
  plan: CreatePlan, attachments: { refs: CreativeAttachment[]; frame: CreativeAttachment | null; tail: CreativeAttachment | null }, cancel: CancelFlag,
): Promise<string> {
  const started = await postMedia("/video_start", {
    model: plan.model, prompt: plan.prompt, seconds: plan.seconds, resolution: plan.resolution,
    aspect_ratio: plan.aspectRatio, frames: videoFrames(attachments.frame, attachments.tail),
    references: attachments.refs, references_ack: plan.referencesAck,
  }, plan.model, cancel);
  const videoId = optStr(started.video_id);
  if (videoId === null) throw new Error("the provider accepted the job but named no id for it");
  return videoId;
}

export function videoFrames(frame: CreativeAttachment | null, tail: CreativeAttachment | null) {
  return [videoFrame(frame, "first_frame"), videoFrame(tail, "last_frame")].filter(Boolean);
}

export function videoFrame(attachment: CreativeAttachment | null, frameType: "first_frame" | "last_frame") {
  if (attachment === null) return null;
  return { ...attachment, frame_type: frameType };
}

export async function waitForVideo(
  runner: ReturnType<typeof runnerDepsFrom>, jobId: string, model: string, videoId: string, cancel: CancelFlag, done: number,
): Promise<void> {
  const deadline = Date.now() + VIDEO_CEILING_MS;
  for (;;) {
    assertVideoNotCancelled(cancel);
    await sleep(VIDEO_POLL_MS);
    assertVideoBeforeDeadline(deadline);
    const status = await postMedia("/video_status", { model, video_id: videoId }, model, cancel);
    assertVideoNotFailed(status);
    if (status.done === true) return;
    emitVideoProgress(runner, jobId, status, done);
  }
}

export function assertVideoNotCancelled(cancel: CancelFlag): void {
  if (cancel.load()) throw new Error("stopped");
}

export function assertVideoBeforeDeadline(deadline: number): void {
  if (Date.now() > deadline) throw new Error("the clip was still not ready after 30 minutes");
}

export function assertVideoNotFailed(status: Record<string, unknown>): void {
  if (status.failed === true) throw new Error(str(status.error, "the provider could not make this clip"));
}

export function emitVideoProgress(runner: ReturnType<typeof runnerDepsFrom>, jobId: string, status: Record<string, unknown>, done: number): void {
  const label = typeof status.progress === "number" ? `Filming… ${status.progress}%` : "Filming…";
  emitProgress(runner.sink, jobId, label, done, 100);
}

export async function persistCreation(
  emit: EventSender, runner: ReturnType<typeof runnerDepsFrom>, roomPath: string, plan: CreatePlan, reply: Record<string, unknown>, index: number,
): Promise<string> {
  const b64 = str(reply.artwork_b64);
  if (b64 === "") throw new Error("the model returned nothing to save");
  const room = roomForCreate(runner, roomPath, "The room was closed before the creation could be saved.");
  const meta = await storeCreativeOutput(room, artworkName(plan.prompt, index, plan.variations, outputExt(reply, plan.kind)), outputMime(reply, plan.kind), Buffer.from(b64, "base64"), outputText(reply, plan.prompt));
  markSectionOnly(room.db, meta.id, "create");
  setShotCreationResult(room.db, plan, index, meta.id);
  emit("room-files-changed", undefined);
  return meta.id;
}

export function outputExt(reply: Record<string, unknown>, kind: CreatePlan["kind"]): string {
  return str(reply.ext, kind === "video" ? "mp4" : "png");
}

export function outputMime(reply: Record<string, unknown>, kind: CreatePlan["kind"]): string {
  return str(reply.mime, kind === "video" ? "video/mp4" : "image/png");
}

export function outputText(reply: Record<string, unknown>, prompt: string): string {
  const narration = str(reply.text);
  return narration === "" ? prompt : `${prompt}\n\n${narration}`;
}

export function setShotCreationResult(db: Database.Database, plan: CreatePlan, index: number, fileId: string): void {
  if (plan.shotId === null || index !== 0) return;
  setShotResult(db, plan.shotId, plan.kind === "image" ? fileId : null, plan.kind === "video" ? fileId : null);
}

export function settleCreateJob(
  runner: ReturnType<typeof runnerDepsFrom>, jobId: string, roomPath: string,
  result: { made: string[]; failure: string | null }, cancel: CancelFlag,
): void {
  const paused = cancel.load();
  const done = creationIsDone(result, paused);
  updateCreateStatus(runner, jobId, roomPath, done, paused, result.failure);
  runner.removeCancelFlag(jobId);
  runner.sink.emit(createCompletion(jobId, result.made, result.failure, done, paused));
}

export function creationIsDone(result: { made: string[]; failure: string | null }, paused: boolean): boolean {
  return result.made.length > 0 && !paused && result.failure === null;
}

export function updateCreateStatus(
  runner: ReturnType<typeof runnerDepsFrom>, jobId: string, roomPath: string, done: boolean, paused: boolean, failure: string | null,
): void {
  const db = pinnedDb(runner.rooms, roomPath);
  if (db !== null) setJobStatus(db, jobId, done ? "done" : paused ? "paused" : "error", done || paused ? null : failure);
}

export function createCompletion(jobId: string, made: string[], failure: string | null, done: boolean, paused: boolean) {
  if (done) return { jobId, label: made.length === 1 ? "Creation ready" : `${made.length} creations ready`, done: 100, total: 100, finished: true, fileId: made[0] };
  if (paused) return { jobId, label: "Paused", done: 0, total: 100, paused: true };
  return { jobId, label: `Stopped — ${failure ?? "nothing came back"}`, done: 0, total: 100, failed: true };
}

export function createStarter(state: RoomManagerState, emit: EventSender): RowStarter {
  return async (queue, job, roomPath, cancel) => {
    const plan = record(job.plan) as unknown as CreatePlan;
    if (typeof plan.prompt !== "string" || typeof plan.model !== "string" || (plan.kind !== "image" && plan.kind !== "video")) return { kind: "error", message: "This job's plan is unreadable." };
    void runCreate(state, emit, queue, job.id, roomPath, plan, cancel);
    return { kind: "runner" };
  };
}

export async function makeCreateJob(state: RoomManagerState, deps: RoomManagerDeps, emit: EventSender, plan: CreatePlan, bulk: boolean): Promise<string> {
  rejectDuringRollback(state);
  const room = roomOrThrow(state);
  rejectWithoutWebAccess(room.conn);
  validateCreatePlan(plan);
  await ensureCanGenerate(plan);
  const queue = ensureQueue(state, deps, emit);
  rejectCreateQueueFull(room.conn, bulk);
  const title = createJobTitle(plan);
  const id = createJob(room.conn, "create", title, plan, 100);
  await submit(queue, id);
  return id;
}

export function rejectWithoutWebAccess(db: Database.Database): void {
  if (!webAccessEnabled(db)) throw new Error("Online features are off for this room.");
}

export function rejectCreateQueueFull(db: Database.Database, bulk: boolean): void {
  if (!bulk && atCapacity(db)) throw new Error(QUEUE_FULL);
}

export function createJobTitle(plan: CreatePlan): string {
  const words = plan.prompt.split(/\s+/);
  const suffix = words.length > 7 ? "…" : "";
  return `${plan.kind === "video" ? "Filming" : "Painting"} “${words.slice(0, 7).join(" ")}${suffix}”`;
}

export interface PlannedRow { plan: CreatePlan | null; preview: ShotPreview }
export function planShotList(db: Database.Database, listId: string, kind: "image" | "video", continuous: boolean): PlannedRow[] {
  const shots = listShots(db, listId);
  const cast = listCast(db);
  const list = listStoryLists(db).find((x) => x.id === listId);
  const inflight = inflightShotIds(db);
  return shots.map((shot, index) => planShot(db, shots, cast, list, inflight, shot, index, kind, continuous));
}

export type StoryShot = ReturnType<typeof listShots>[number];
export type CastMember = ReturnType<typeof listCast>[number];
export type StoryList = ReturnType<typeof listStoryLists>[number];

export function inflightShotIds(db: Database.Database): Set<string> {
  return new Set(unfinishedJobs(db)
    .filter((job) => job.kind === "create")
    .map((job) => optStr(record(job.plan).shotId))
    .filter((id): id is string => id !== null));
}

export function planShot(
  db: Database.Database, shots: StoryShot[], cast: CastMember[], list: StoryList | undefined,
  inflight: Set<string>, shot: StoryShot, index: number, kind: CreatePlan["kind"], continuous: boolean,
): PlannedRow {
  const members = shotCastMembers(shot, cast);
  const prompt = shotPrompt(shot.action, members, list?.logline ?? "");
  const model = selectedShotModel(shot, kind);
  const preview = shotPreview(shot, index, prompt, model, members);
  const skip = shotSkipReason(shot, kind, model, inflight);
  if (skip !== null) return { plan: null, preview: { ...preview, skip } };
  const plan = shotCreatePlan(db, shots, list, shot, index, prompt, model, kind, continuous);
  return applyShotPlan(preview, plan, shots, index, inflight, continuous);
}

export function shotCastMembers(shot: StoryShot, cast: CastMember[]): CastMember[] {
  return shot.castIds.map((id) => cast.find((member) => member.id === id))
    .filter((member): member is CastMember => member !== undefined);
}

export function selectedShotModel(shot: StoryShot, kind: CreatePlan["kind"]): string {
  return (kind === "video" ? shot.videoModel : shot.imageModel).trim();
}

export function shotPreview(shot: StoryShot, index: number, prompt: string, model: string, members: CastMember[]): ShotPreview {
  return {
    shotId: shot.id, n: index + 1, action: shot.action, prompt, seconds: shot.seconds, model: providerSlug(model),
    startFileId: null, endFileId: null, referenceFileIds: [], cast: members.map((member) => member.name),
    faceless: members.filter((member) => member.faceFileId === null).map((member) => member.name),
    joinDropped: null, startsOnPrevious: false, skip: null,
  };
}

export function shotSkipReason(shot: StoryShot, kind: CreatePlan["kind"], model: string, inflight: Set<string>): string | null {
  if (inflight.has(shot.id)) return inflightShotMessage(kind);
  if (shotAlreadyMade(shot, kind)) return completedShotMessage(kind);
  if (model === "") return missingShotModelMessage(kind);
  return null;
}

export function inflightShotMessage(kind: CreatePlan["kind"]): string {
  return kind === "video" ? "already being filmed — a job for it is queued or running" : "already being drawn — a job for it is queued or running";
}

export function shotAlreadyMade(shot: StoryShot, kind: CreatePlan["kind"]): boolean {
  return (kind === "video" ? shot.clipFileId : shot.stillFileId) !== null;
}

export function completedShotMessage(kind: CreatePlan["kind"]): string {
  return kind === "video" ? "already filmed" : "already drawn";
}

export function missingShotModelMessage(kind: CreatePlan["kind"]): string {
  return kind === "video" ? "no clip model chosen" : "no picture model chosen";
}

export function shotCreatePlan(
  db: Database.Database, shots: StoryShot[], list: StoryList | undefined, shot: StoryShot, index: number,
  prompt: string, model: string, kind: CreatePlan["kind"], continuous: boolean,
): CreatePlan {
  return {
    prompt, model, kind, variations: 1, seconds: shot.seconds, resolution: shotResolution(kind, list),
    aspectRatio: list?.aspectRatio ?? "", referenceFileIds: kind === "image" ? castFaces(db, shot.castIds) : [],
    frameFileId: kind === "video" ? shot.stillFileId : null, lastFrameFileId: nextStill(shots, index, kind, continuous),
    chained: kind === "video" && continuous, referencesAck: true, shotId: shot.id,
  };
}

export function shotResolution(kind: CreatePlan["kind"], list: StoryList | undefined): string {
  return kind === "video" ? list?.clipResolution ?? "" : list?.stillResolution ?? "";
}

export function nextStill(shots: StoryShot[], index: number, kind: CreatePlan["kind"], continuous: boolean): string | null {
  if (kind !== "video" || !continuous) return null;
  return shots[index + 1]?.stillFileId ?? null;
}

export function applyShotPlan(
  preview: ShotPreview, plan: CreatePlan, shots: StoryShot[], index: number, inflight: Set<string>, continuous: boolean,
): PlannedRow {
  const validationError = validateShotPlan(plan);
  if (validationError !== null) return { plan: null, preview: { ...preview, skip: validationError } };
  preview.seconds = plan.seconds;
  preview.startFileId = plan.frameFileId;
  preview.endFileId = plan.lastFrameFileId;
  preview.referenceFileIds = plan.referenceFileIds;
  addShotJoinMetadata(preview, plan, nextStill(shots, index, plan.kind, continuous), shots[index - 1], index, inflight, continuous);
  return { plan, preview };
}

export function validateShotPlan(plan: CreatePlan): string | null {
  try {
    validateCreatePlan(plan);
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

export function addShotJoinMetadata(
  preview: ShotPreview, plan: CreatePlan, expectedEnd: string | null, previous: StoryShot | undefined,
  index: number, inflight: Set<string>, continuous: boolean,
): void {
  if (expectedEnd !== null && plan.lastFrameFileId === null) preview.joinDropped = preview.model;
  preview.startsOnPrevious = canStartOnPrevious(preview, previous, index, inflight, continuous);
}

export function canStartOnPrevious(
  preview: ShotPreview, previous: StoryShot | undefined, index: number, inflight: Set<string>, continuous: boolean,
): boolean {
  if (preview.model === "" || !continuous || index === 0) return false;
  if (!previousShotHasClip(previous, inflight)) return false;
  const limits = limitsFor(preview.model);
  return limits === undefined || takesFirstFrame(limits);
}

export function previousShotHasClip(previous: StoryShot | undefined, inflight: Set<string>): boolean {
  return previous?.clipFileId !== null || inflight.has(previous?.id ?? "");
}
