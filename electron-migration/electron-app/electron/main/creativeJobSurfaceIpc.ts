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
  getFileBytes,
  getFileExtractedText,
  getFileMeta,
  insertFile,
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
import { emitProgress, pinnedDb, runPlan, spawnJobRunner, spawnPodcastAudio, type Step } from "./jobs.js";
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

const MAX_VARIATIONS = 4;
const MAX_SHOT_RUN = 80;
const VIDEO_POLL_MS = 2_000;
const VIDEO_CEILING_MS = 30 * 60_000;

interface CreatePlan {
  prompt: string;
  model: string;
  kind: "image" | "video";
  variations: number;
  seconds: number | null;
  resolution: string;
  aspectRatio: string;
  referenceFileIds: string[];
  frameFileId: string | null;
  lastFrameFileId: string | null;
  chained: boolean;
  referencesAck: boolean;
  shotId: string | null;
}

interface StudioPlan {
  kind: string;
  scope: string | null;
  instructions: string | null;
  refs: string[] | null;
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
function str(v: unknown, fallback = ""): string { return typeof v === "string" ? v : fallback; }
function optStr(v: unknown): string | null { return typeof v === "string" && v.trim() !== "" ? v : null; }
function stringList(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; }
function errorMessage(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function roomOrThrow(state: RoomManagerState): NonNullable<RoomManagerState["room"]> {
  if (state.room === null) throw new Error("No room is open.");
  return state.room;
}
function queueOrThrow(deps: RoomManagerDeps): JobQueueDeps {
  if (deps.jobQueue === undefined) throw new Error("The background job queue is unavailable.");
  return deps.jobQueue;
}
function ensureQueue(state: RoomManagerState, deps: RoomManagerDeps, emit: EventSender): JobQueueDeps {
  if (deps.jobQueue !== undefined) return deps.jobQueue;
  const queue: JobQueueDeps = {
    state: createJobQueueState(),
    rooms: roomSource(state),
    sink: { emit: (payload) => emit("job-progress", payload) },
    cancelState: state.cancel,
    starters: defaultRowStarters(),
  };
  deps.jobQueue = queue;
  return queue;
}
function roomSource(state: RoomManagerState) {
  return {
    current: () => state.room === null ? null : {
      db: state.room.conn,
      path: state.room.path,
      name: state.room.name,
      ...(state.room.workspace === undefined ? {} : { workspace: state.room.workspace }),
    },
    rollingBack: () => state.rollingBack,
  };
}
function setStarter(queue: JobQueueDeps, kind: string, starter: RowStarter): void {
  const mutable = queue.starters as Map<string, RowStarter>;
  if (typeof mutable.set !== "function") throw new Error("The background job registry is read-only.");
  mutable.set(kind, starter);
}

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

export async function startDeepSummaryJob(
  state: RoomManagerState,
  deps: RoomManagerDeps,
  auto: boolean,
): Promise<string> {
  if (state.rollingBack) throw new Error("A room rollback is in progress — try again when it finishes.");
  const queue = queueOrThrow(deps);
  const room = roomOrThrow(state);
  const roomPath = room.path;
  if (atCapacity(room.conn)) throw new Error(QUEUE_FULL);
  const files = auto
    ? filesMissingSummary(room.conn, MAX_SUMMARY_FILES).map(([id]) => ({ id }))
    : listFilesForSummary(room.conn)
        .filter((file) => !isSummaryFile(file.name, file.source))
        .slice(0, MAX_SUMMARY_FILES);
  if (files.length === 0) {
    throw new Error(auto ? "There are no new files to index." : "This room has no files to summarize yet.");
  }
  const model = await resolveSummaryModel(room.conn);
  if (state.room === null || state.room.path !== roomPath) {
    throw new Error("The room changed while the summary was starting.");
  }
  const id = createJob(
    state.room.conn,
    "deep_summary",
    auto ? "Indexing new files" : "Room summary",
    { fileIds: files.map((file) => file.id), model, auto, reduce: !auto },
    files.length,
  );
  await submit(queue, id);
  return id;
}
function progressSink(emit: EventSender) { return { emit: (p: Parameters<typeof emitProgress>[1]) => emit("job-progress", p) }; }

function studioFactories() {
  return { flashcards: flashcardsSpec, mindmap: mindmapSpec, podcast: podcastSpec };
}

function parseStudioPlan(v: unknown): StudioPlan | null {
  const o = record(v);
  if (typeof o.kind !== "string") return null;
  return {
    kind: o.kind,
    scope: typeof o.scope === "string" ? o.scope : null,
    instructions: typeof o.instructions === "string" ? o.instructions : null,
    refs: Array.isArray(o.refs) ? stringList(o.refs) : null,
  };
}

function studioStarter(state: RoomManagerState, emit: EventSender): RowStarter {
  return async (queue, job, roomPath, cancel) => {
    const plan = parseStudioPlan(job.plan);
    if (plan === null) return { kind: "error", message: "This job's plan is unreadable." };
    const spec = studioSpecFor(plan.kind, studioFactories());
    if (spec === null) return { kind: "error", message: `Unknown studio kind '${plan.kind}'.` };
    const runner = runnerDepsFrom(queue);
    void spawnJobRunner(runner, job.id, roomPath, async () => {
      const startDb = pinnedDb(runner.rooms, roomPath);
      if (startDb !== null) setJobStatus(startDb, job.id, "running", null);
      emitProgress(runner.sink, job.id, "Starting…", 0, 0);
      let fileId: string | null = null;
      let failure: string | null = null;
      try {
        fileId = (await runStudioCore(
          { rooms: roomSource(state), cancelState: state.cancel, emit }, spec,
          plan.scope, plan.instructions, plan.refs, cancel, roomPath,
        )).id;
      } catch (e) { failure = errorMessage(e); }
      const endDb = pinnedDb(runner.rooms, roomPath);
      const paused = cancel.load();
      if (endDb !== null) setJobStatus(endDb, job.id, fileId !== null ? "done" : paused ? "paused" : "error", fileId !== null || paused ? null : failure);
      runner.removeCancelFlag(job.id);
      runner.sink.emit(fileId !== null
        ? { jobId: job.id, label: `${studioTitle(plan.kind)} ready`, done: 1, total: 1, finished: true, fileId }
        : paused
          ? { jobId: job.id, label: "Paused", done: 0, total: 1, paused: true }
          : { jobId: job.id, label: `Stopped — ${failure ?? "unknown error"}`, done: 0, total: 1, failed: true });
      await runner.onSettled(job.id);
    });
    return { kind: "runner" };
  };
}

function podcastStarter(state: RoomManagerState, emit: EventSender): RowStarter {
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

async function resolveSummaryModel(db: Database.Database): Promise<string> {
  const configured = modelSetting(db);
  if (configured !== null && configured.trim() !== "") return configured;
  return bestLocalDefault(await listModels());
}

function deepSummaryStarter(state: RoomManagerState, emit: EventSender): RowStarter {
  return async (queue, job, roomPath, cancel) => {
    const plan = record(job.plan);
    const fileIds = stringList(plan.fileIds);
    const model = optStr(plan.model);
    if (fileIds.length === 0 || model === null) return { kind: "error", message: "This job's plan is unreadable." };
    const auto = plan.auto === true;
    const reduce = plan.reduce !== false;
    const runner = runnerDepsFrom(queue);
    void spawnJobRunner(runner, job.id, roomPath, async () => {
      const initial = pinnedDb(runner.rooms, roomPath);
      if (initial !== null) setJobStatus(initial, job.id, "running", null);
      const steps: Step[] = fileIds.map((_, id) => ({ id, lane: runsOnThisMac(model) ? "local_llm" : "cloud", kind: "summarize_file", params: null, dependsOn: [] }));
      let cursor = Math.max(0, Math.min(job.cursor, steps.length));
      const outcome = await runPlan(
        steps, new Set(Array.from({ length: cursor }, (_, i) => i)), cancel,
        async (step) => {
          const db = pinnedDb(runner.rooms, roomPath);
          if (db === null) return { ok: false, error: "the room this job belongs to was closed" };
          const id = fileIds[step.id];
          if (id === undefined) return { ok: false, error: "This job's plan is unreadable." };
          const meta = getFileMeta(db, id);
          if (meta.aiSummary?.trim()) return { ok: true };
          const text = getFileExtractedText(db, id);
          if (text === null || text.trim() === "") return { ok: true };
          try {
            const liner = await summarizeOneFile(model, meta.name, meta.mimeType, text, "30m");
            const still = pinnedDb(runner.rooms, roomPath);
            if (still !== null && (liner.trim() !== "" || auto)) setFileAiSummary(still, id, liner);
            return { ok: true };
          } catch (e) {
            const message = errorMessage(e);
            return message === "OLLAMA_DOWN" || message.startsWith("MODEL_MISSING")
              ? { ok: false, error: message }
              : { ok: true };
          }
        },
        (done) => {
          cursor = 0;
          while (done.has(cursor)) cursor += 1;
          const db = pinnedDb(runner.rooms, roomPath);
          if (db !== null) checkpointJob(db, job.id, cursor, {});
        },
        (done, total) => emitProgress(runner.sink, job.id, done >= total ? "Finishing…" : `${auto ? "Indexing" : "Summarizing"} file ${done + 1} of ${total}…`, done, total),
      );
      let final = outcome;
      let fileId: string | undefined;
      if (outcome.kind === "done" && reduce && !cancel.load()) {
        try {
          emitProgress(runner.sink, job.id, "Writing the summary…", steps.length, steps.length);
          fileId = (await writeRoomSummary(roomSource(state), model, roomPath, { emit })).id;
        } catch (e) { final = { kind: "error", error: errorMessage(e) }; }
      } else if (outcome.kind === "done" && cancel.load()) final = { kind: "paused" };
      const end = pinnedDb(runner.rooms, roomPath);
      if (end !== null) setJobStatus(end, job.id, final.kind === "done" ? "done" : final.kind === "paused" ? "paused" : "error", final.kind === "error" ? final.error : null);
      runner.removeCancelFlag(job.id);
      runner.sink.emit(final.kind === "done"
        ? { jobId: job.id, label: auto ? "Indexing finished" : "Summary ready", done: steps.length, total: steps.length, finished: true, ...(fileId !== undefined && !auto ? { fileId } : {}) }
        : final.kind === "paused"
          ? { jobId: job.id, label: "Paused", done: cursor, total: steps.length, paused: true }
          : { jobId: job.id, label: `Stopped — ${final.error}`, done: cursor, total: steps.length, failed: true });
      await runner.onSettled(job.id);
    });
    return { kind: "runner" };
  };
}

function attachment(db: Database.Database, id: string): { b64: string; mime: string } {
  const bytes = getFileBytes(db, id);
  if (bytes === null) throw new Error("That reference file has no saved bytes.");
  return { b64: bytes.toString("base64"), mime: getFileMeta(db, id).mimeType };
}

async function postMedia(path: string, body: Record<string, unknown>, model: string, cancel: CancelFlag, timeout?: number): Promise<Record<string, unknown>> {
  await ensureProviderCatalog(model);
  const policy = injectPolicy(body) ?? body;
  const wire = injectProviderRuntime(policy, model);
  const outcome = await sidecarJsonCancellable(path, wire, cancel, timeout);
  if (outcome.kind === "stopped") throw new Error("stopped");
  if (outcome.kind === "error") throw new Error(outcome.error.error);
  return record(outcome.value);
}

function validateCreatePlan(plan: CreatePlan): void {
  plan.prompt = plan.prompt.trim();
  if (plan.kind !== "image" && plan.kind !== "video") throw new Error("Unknown thing to make.");
  if (plan.prompt === "" && !(plan.kind === "video" && plan.frameFileId !== null)) throw new Error("Say what to make first.");
  plan.variations = Math.max(1, Math.min(MAX_VARIATIONS, Math.trunc(plan.variations || 1)));
  const slug = plan.model.includes("::") ? plan.model.split("::").slice(1).join("::") : plan.model;
  const limits = limitsFor(slug);
  if (limits !== undefined) {
    plan.referenceFileIds = plan.referenceFileIds.slice(0, limits.maxReferences ?? plan.referenceFileIds.length);
    if (plan.aspectRatio !== "" && limits.aspectRatios.length > 0 && !limits.aspectRatios.includes(plan.aspectRatio)) plan.aspectRatio = "";
    if (plan.resolution !== "" && limits.resolutions.length > 0 && !limits.resolutions.includes(plan.resolution)) plan.resolution = "";
    if (plan.kind === "video") {
      if (plan.frameFileId !== null && !takesFirstFrame(limits)) throw new Error(`${slug} cannot start from a picture.`);
      if (plan.lastFrameFileId !== null && !limits.frameImages.includes("last_frame")) plan.lastFrameFileId = null;
      if (plan.seconds !== null && !allowsSeconds(limits, plan.seconds)) throw new Error(`${slug} does not make ${plan.seconds}-second clips.`);
      if (plan.seconds === null) plan.seconds = defaultSeconds(limits);
    }
  }
  if (plan.kind === "image") plan.seconds = null;
}

async function ensureCanGenerate(plan: CreatePlan): Promise<void> {
  await ensureProviderCatalog(plan.model);
  const facts = providerModelFacts(plan.model);
  const yes = plan.kind === "image" ? facts?.imageOutput : facts?.videoOutput;
  if (yes !== true) throw new Error(`The selected model cannot make ${plan.kind === "image" ? "pictures" : "clips"}. Pick a model from the Create page.`);
}

function artworkName(prompt: string, index: number, count: number, ext: string): string {
  const words = prompt.trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ") || "Creation";
  const safe = words.replace(/[\\/:*?"<>|]/g, "-").slice(0, 70);
  return `${safe}${count > 1 ? ` ${index + 1}` : ""}.${ext}`;
}

async function runCreate(state: RoomManagerState, emit: EventSender, queue: JobQueueDeps, jobId: string, roomPath: string, plan: CreatePlan, cancel: CancelFlag): Promise<void> {
  const runner = runnerDepsFrom(queue);
  await spawnJobRunner(runner, jobId, roomPath, async () => {
    const first = pinnedDb(runner.rooms, roomPath);
    if (first !== null) setJobStatus(first, jobId, "running", null);
    let made: string[] = [];
    let failure: string | null = null;
    try {
      const readDb = pinnedDb(runner.rooms, roomPath);
      if (readDb === null) throw new Error("the room this job belongs to was closed");
      const refs = plan.referenceFileIds.map((id) => attachment(readDb, id));
      const frame = plan.frameFileId === null ? null : attachment(readDb, plan.frameFileId);
      const tail = plan.lastFrameFileId === null ? null : attachment(readDb, plan.lastFrameFileId);
      for (let index = 0; index < plan.variations && !cancel.load(); index += 1) {
        const done = Math.floor(index * 100 / plan.variations);
        emitProgress(runner.sink, jobId, plan.kind === "video" ? "Filming…" : "Painting…", done, 100);
        let reply: Record<string, unknown>;
        if (plan.kind === "image") {
          reply = await postMedia("/image_generate", {
            model: plan.model, prompt: plan.prompt, kind: plan.kind,
            reference_b64: refs.map((r) => r.b64), reference_mime: refs.map((r) => r.mime),
            references_ack: plan.referencesAck, aspect_ratio: plan.aspectRatio, resolution: plan.resolution,
          }, plan.model, cancel);
        } else {
          const frames = [frame === null ? null : { ...frame, frame_type: "first_frame" }, tail === null ? null : { ...tail, frame_type: "last_frame" }].filter(Boolean);
          const started = await postMedia("/video_start", {
            model: plan.model, prompt: plan.prompt, seconds: plan.seconds, resolution: plan.resolution,
            aspect_ratio: plan.aspectRatio, frames, references: refs, references_ack: plan.referencesAck,
          }, plan.model, cancel);
          const videoId = optStr(started.video_id);
          if (videoId === null) throw new Error("the provider accepted the job but named no id for it");
          const deadline = Date.now() + VIDEO_CEILING_MS;
          for (;;) {
            if (cancel.load()) throw new Error("stopped");
            await sleep(VIDEO_POLL_MS);
            if (Date.now() > deadline) throw new Error("the clip was still not ready after 30 minutes");
            const status = await postMedia("/video_status", { model: plan.model, video_id: videoId }, plan.model, cancel);
            if (status.failed === true) throw new Error(str(status.error, "the provider could not make this clip"));
            if (status.done === true) break;
            emitProgress(runner.sink, jobId, typeof status.progress === "number" ? `Filming… ${status.progress}%` : "Filming…", done, 100);
          }
          emitProgress(runner.sink, jobId, "Downloading the clip…", done, 100);
          reply = await postMedia("/video_fetch", { model: plan.model, video_id: videoId }, plan.model, cancel, 600_000);
        }
        if (cancel.load()) break;
        const b64 = str(reply.artwork_b64);
        if (b64 === "") throw new Error("the model returned nothing to save");
        const bytes = Buffer.from(b64, "base64");
        const mime = str(reply.mime, plan.kind === "video" ? "video/mp4" : "image/png");
        const ext = str(reply.ext, plan.kind === "video" ? "mp4" : "png");
        const db = pinnedDb(runner.rooms, roomPath);
        if (db === null) throw new Error("The room was closed before the creation could be saved.");
        const narration = str(reply.text);
        const meta = insertFile(db, artworkName(plan.prompt, index, plan.variations, ext), mime, bytes, narration === "" ? plan.prompt : `${plan.prompt}\n\n${narration}`, "generated");
        markSectionOnly(db, meta.id, "create");
        if (plan.shotId !== null && index === 0) setShotResult(db, plan.shotId, plan.kind === "image" ? meta.id : null, plan.kind === "video" ? meta.id : null);
        made.push(meta.id);
        emit("room-files-changed", undefined);
      }
    } catch (e) { failure = errorMessage(e); }
    const paused = cancel.load();
    const end = pinnedDb(runner.rooms, roomPath);
    const done = made.length > 0 && !paused && failure === null;
    if (end !== null) setJobStatus(end, jobId, done ? "done" : paused ? "paused" : "error", done || paused ? null : failure);
    runner.removeCancelFlag(jobId);
    runner.sink.emit(done
      ? { jobId, label: made.length === 1 ? "Creation ready" : `${made.length} creations ready`, done: 100, total: 100, finished: true, fileId: made[0] }
      : paused
        ? { jobId, label: "Paused", done: 0, total: 100, paused: true }
        : { jobId, label: `Stopped — ${failure ?? "nothing came back"}`, done: 0, total: 100, failed: true });
    await runner.onSettled(jobId);
  });
}

function createStarter(state: RoomManagerState, emit: EventSender): RowStarter {
  return async (queue, job, roomPath, cancel) => {
    const plan = record(job.plan) as unknown as CreatePlan;
    if (typeof plan.prompt !== "string" || typeof plan.model !== "string" || (plan.kind !== "image" && plan.kind !== "video")) return { kind: "error", message: "This job's plan is unreadable." };
    void runCreate(state, emit, queue, job.id, roomPath, plan, cancel);
    return { kind: "runner" };
  };
}

async function makeCreateJob(state: RoomManagerState, deps: RoomManagerDeps, emit: EventSender, plan: CreatePlan, bulk: boolean): Promise<string> {
  if (state.rollingBack) throw new Error("A room rollback is in progress — try again when it finishes.");
  const room = roomOrThrow(state);
  if (!webAccessEnabled(room.conn)) throw new Error("Online features are off for this room.");
  validateCreatePlan(plan);
  await ensureCanGenerate(plan);
  const queue = ensureQueue(state, deps, emit);
  if (!bulk && atCapacity(room.conn)) throw new Error(QUEUE_FULL);
  const title = `${plan.kind === "video" ? "Filming" : "Painting"} “${plan.prompt.split(/\s+/).slice(0, 7).join(" ")}${plan.prompt.split(/\s+/).length > 7 ? "…" : ""}”`;
  const id = createJob(room.conn, "create", title, plan, 100);
  await submit(queue, id);
  return id;
}

interface PlannedRow { plan: CreatePlan | null; preview: ShotPreview }
function planShotList(db: Database.Database, listId: string, kind: "image" | "video", continuous: boolean): PlannedRow[] {
  const shots = listShots(db, listId);
  const cast = listCast(db);
  const list = listStoryLists(db).find((x) => x.id === listId);
  const inflight = new Set(unfinishedJobs(db).filter((j) => j.kind === "create").map((j) => optStr(record(j.plan).shotId)).filter((x): x is string => x !== null));
  return shots.map((shot, index) => {
    const members = shot.castIds.map((id) => cast.find((c) => c.id === id)).filter((x): x is NonNullable<typeof x> => x !== undefined);
    const prompt = shotPrompt(shot.action, members, list?.logline ?? "");
    const model = (kind === "video" ? shot.videoModel : shot.imageModel).trim();
    const preview: ShotPreview = {
      shotId: shot.id, n: index + 1, action: shot.action, prompt, seconds: shot.seconds,
      model: model.includes("::") ? model.split("::").slice(1).join("::") : model,
      startFileId: null, endFileId: null, referenceFileIds: [],
      cast: members.map((m) => m.name), faceless: members.filter((m) => m.faceFileId === null).map((m) => m.name),
      joinDropped: null, startsOnPrevious: false, skip: null,
    };
    if (inflight.has(shot.id)) preview.skip = kind === "video" ? "already being filmed — a job for it is queued or running" : "already being drawn — a job for it is queued or running";
    else if ((kind === "video" ? shot.clipFileId : shot.stillFileId) !== null) preview.skip = kind === "video" ? "already filmed" : "already drawn";
    else if (model === "") preview.skip = kind === "video" ? "no clip model chosen" : "no picture model chosen";
    if (preview.skip !== null) return { plan: null, preview };
    const refs = kind === "image" ? castFaces(db, shot.castIds) : [];
    const nextStill = kind === "video" && continuous ? shots[index + 1]?.stillFileId ?? null : null;
    const plan: CreatePlan = {
      prompt, model, kind, variations: 1, seconds: shot.seconds,
      resolution: kind === "video" ? list?.clipResolution ?? "" : list?.stillResolution ?? "",
      aspectRatio: list?.aspectRatio ?? "", referenceFileIds: refs,
      frameFileId: kind === "video" ? shot.stillFileId : null, lastFrameFileId: nextStill,
      chained: kind === "video" && continuous, referencesAck: true, shotId: shot.id,
    };
    try { validateCreatePlan(plan); }
    catch (e) { preview.skip = errorMessage(e); return { plan: null, preview }; }
    preview.seconds = plan.seconds;
    preview.startFileId = plan.frameFileId;
    preview.endFileId = plan.lastFrameFileId;
    preview.referenceFileIds = plan.referenceFileIds;
    if (nextStill !== null && plan.lastFrameFileId === null) preview.joinDropped = preview.model;
    const prev = shots[index - 1];
    preview.startsOnPrevious = kind === "video" && continuous && index > 0 && (prev?.clipFileId !== null || inflight.has(prev?.id ?? "")) && (limitsFor(preview.model) === undefined || takesFirstFrame(limitsFor(preview.model)!));
    return { plan, preview };
  });
}

export function registerCreativeJobSurfaceIpc(
  ipcMain: Pick<IpcMain, "handle">,
  state: RoomManagerState,
  deps: RoomManagerDeps,
  emit: EventSender,
): void {
  const queue = installCreativeJobStarters(state, deps, emit);

  ipcMain.handle("start_deep_summary", async () => {
    return startDeepSummaryJob(state, deps, false);
  });

  ipcMain.handle("start_studio_job", async (_event: IpcMainInvokeEvent, raw: unknown) => {
    if (state.rollingBack) throw new Error("A room rollback is in progress — try again when it finishes.");
    const args = record(raw);
    const plan: StudioPlan = { kind: str(args.kind), scope: typeof args.scope === "string" ? args.scope : null, instructions: typeof args.instructions === "string" ? args.instructions : null, refs: Array.isArray(args.refs) ? stringList(args.refs) : null };
    if (studioSpecFor(plan.kind, studioFactories()) === null) throw new Error("Unknown studio kind.");
    const room = roomOrThrow(state);
    if (atCapacity(room.conn)) throw new Error(QUEUE_FULL);
    const id = createJob(room.conn, "studio", studioTitle(plan.kind), plan, 0);
    await submit(queue, id);
    return id;
  });

  ipcMain.handle("start_podcast_audio_job", async (_event: IpcMainInvokeEvent, raw: unknown) => {
    const scriptFileId = str(record(raw).scriptFileId);
    const room = roomOrThrow(state);
    const podcast = getPodcast(room.conn, scriptFileId);
    if (podcast === null) throw new Error("This file has no podcast script attached. Scripts made before voices existed have to be generated again before they can be recorded.");
    if (podcast.turns.length === 0) throw new Error("This script has no lines to read.");
    if (atCapacity(room.conn)) throw new Error(QUEUE_FULL);
    const id = createJob(room.conn, "podcast_audio", "Podcast episode", { scriptFileId }, 1);
    await submit(queue, id);
    return id;
  });

  ipcMain.handle("start_create_job", async (_event: IpcMainInvokeEvent, raw: unknown) => {
    const a = record(raw);
    const plan: CreatePlan = {
      prompt: str(a.prompt), model: str(a.model), kind: a.kind === "video" ? "video" : "image",
      variations: typeof a.variations === "number" ? a.variations : 1,
      seconds: typeof a.seconds === "number" ? Math.trunc(a.seconds) : null,
      resolution: str(a.resolution), aspectRatio: str(a.aspectRatio), referenceFileIds: stringList(a.referenceFileIds),
      frameFileId: optStr(a.frameFileId), lastFrameFileId: null, chained: false,
      referencesAck: a.referencesAck === true, shotId: optStr(a.shotId),
    };
    return makeCreateJob(state, deps, emit, plan, false);
  });

  ipcMain.handle("story_film_plan", (_event: IpcMainInvokeEvent, raw: unknown): FilmPlan => {
    const a = record(raw);
    const kind = a.kind === "video" ? "video" : "image";
    const rows = planShotList(roomOrThrow(state).conn, str(a.listId), kind, a.continuous !== false);
    const active = rows.filter((r) => r.plan !== null);
    const faceless = [...new Set(active.flatMap((r) => r.preview.faceless))];
    return {
      kind, shots: rows.map((r) => r.preview), sending: active.length, skipped: rows.length - active.length,
      totalSeconds: active.reduce((n, r) => n + (r.plan?.seconds ?? 0), 0),
      joined: rows.filter((r) => r.preview.startsOnPrevious).length, overCap: active.length > MAX_SHOT_RUN,
      joinBlockedBy: rows.find((r) => r.preview.joinDropped !== null)?.preview.joinDropped ?? null, faceless,
    };
  });

  ipcMain.handle("start_shot_list_job", async (_event: IpcMainInvokeEvent, raw: unknown): Promise<ShotRunStarted> => {
    const a = record(raw);
    const kind = a.kind === "video" ? "video" : "image";
    const room = roomOrThrow(state);
    const plannedRoom = room.path;
    const plans = planShotList(room.conn, str(a.listId), kind, a.continuous !== false).flatMap((r) => r.plan === null ? [] : [r.plan]);
    if (plans.length === 0) throw new Error(kind === "video" ? "Nothing to film — every shot either has a clip already or has no video model chosen." : "Nothing to draw — every shot either has a picture already or has no picture model chosen.");
    if (plans.length > MAX_SHOT_RUN) throw new Error(`That is ${plans.length} generations in one go, and this room will queue ${MAX_SHOT_RUN} at a time.`);
    const asked = plans.length;
    const jobIds: string[] = [];
    let failure: string | null = null;
    for (const plan of plans) {
      if (state.room?.path !== plannedRoom) { failure = "the room changed while these were being queued"; break; }
      try { jobIds.push(await makeCreateJob(state, deps, emit, plan, true)); }
      catch (e) { failure = errorMessage(e); break; }
    }
    if (jobIds.length === 0) throw new Error(failure ?? "nothing could be started");
    return { jobIds, asked, shortfall: jobIds.length < asked ? `Only ${jobIds.length} of ${asked} could be started — ${failure ?? "the room stopped accepting them"}` : null };
  });
}
