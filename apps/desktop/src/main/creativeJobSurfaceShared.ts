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


export const MAX_VARIATIONS = 4;
export const MAX_SHOT_RUN = 80;
export const VIDEO_POLL_MS = 2_000;
export const VIDEO_CEILING_MS = 30 * 60_000;

export interface CreatePlan {
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

export interface StudioPlan {
  kind: string;
  scope: string | null;
  instructions: string | null;
  refs: string[] | null;
}

export function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
export function str(v: unknown, fallback = ""): string { return typeof v === "string" ? v : fallback; }
export function optStr(v: unknown): string | null { return typeof v === "string" && v.trim() !== "" ? v : null; }
export function stringList(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; }
export function errorMessage(e: unknown): string { return e instanceof Error ? e.message : String(e); }
export function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
export function roomOrThrow(state: RoomManagerState): NonNullable<RoomManagerState["room"]> {
  if (state.room === null) throw new Error("No room is open.");
  return state.room;
}
export function queueOrThrow(deps: RoomManagerDeps): JobQueueDeps {
  if (deps.jobQueue === undefined) throw new Error("The background job queue is unavailable.");
  return deps.jobQueue;
}
export function progressSink(emit: EventSender): ProgressSink {
  return { emit: (payload) => emit("job-progress", payload) };
}
export function ensureQueue(state: RoomManagerState, deps: RoomManagerDeps, emit: EventSender): JobQueueDeps {
  if (deps.jobQueue !== undefined) return deps.jobQueue;
  const queue: JobQueueDeps = {
    state: createJobQueueState(),
    rooms: roomSource(state),
    sink: progressSink(emit),
    cancelState: state.cancel,
    starters: defaultRowStarters(),
  };
  deps.jobQueue = queue;
  return queue;
}
export function roomSource(state: RoomManagerState) {
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
export function setStarter(queue: JobQueueDeps, kind: string, starter: RowStarter): void {
  const mutable = queue.starters as Map<string, RowStarter>;
  if (typeof mutable.set !== "function") throw new Error("The background job registry is read-only.");
  mutable.set(kind, starter);
}
