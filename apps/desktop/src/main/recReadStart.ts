/** Cohesive extraction from recRead.ts; its public API remains on that module. */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3-multiple-ciphers";

import { CancelFlag } from "./cancel.js";
import { getFileName, setFileExtractedText } from "./db-host/files.js";
import {
  checkpointJob,
  createJob,
  getJobArtifact,
  listJobs,
  putJobArtifact,
  setJobStatus,
  type Job,
} from "./db-host/jobs.js";
import { getRecMeta, setRecMeta } from "./db-host/recordings.js";
import { resolvedBaseUrl } from "./engineRouting.js";
import {
  atCapacity,
  QUEUE_FULL,
  runnerDepsFrom,
  tryReserve,
  UNREADABLE_PLAN,
  type JobQueueDeps,
  type RowStarter,
  type RowStartResult,
} from "./jobQueue.js";
import {
  densePrefix,
  emitProgress,
  pinnedDb,
  runPlan,
  spawnJobRunner,
  type CancelSignal,
  type JobProgressPayload,
  type JobRunnerDeps,
  type Lane,
  type ProgressSink,
  type RoomHandle,
  type RoomSource,
  type RunOutcome,
  type Step,
  type StepResult,
} from "./jobs.js";
import * as obs from "./obs.js";
import { parseRecMeta } from "./recBridge.js";
import {
  displaySpeaker,
  formatStamp,
  readStampOf,
  segmentVisibleText,
  transcriptText,
  type By,
  type NoteKind,
  type ReadStamp,
  type RecChapter,
  type RecHighlight,
  type RecMeta,
  type RecNote,
} from "./recFormat.js";
import { authedHeaders, busy, ensureUp } from "./sidecar.js";

export type { JobProgressPayload, ProgressSink, RoomSource };
import { asRecord, buildReadSteps, parseReadPlan, stampsEqual } from "./recReadMerge.js";
import { partitionTurns } from "./recReadPlan.js";
import { spawnRecRead } from "./recReadRunner.js";
import { RecReadSidecarCall } from "./recReadSidecar.js";
import { ROOM_GONE } from "./recReadSteps.js";
import { RecReadDoneEvent, RecReadLog, RecReadRunnerDeps, ResolveReadEngine, resolveReadEngineNotImplemented } from "./recReadStorage.js";
import { READ_WINDOW_CHARS, ReadPlan, Turn, turnsMoved, turnsOf, visibleChars } from "./recReadTypes.js";
// =============================================================================
// startRecRead / readingNow / recReadRowStarter (rec_read.rs:547-670)
// =============================================================================

/** Everything `rec_read`'s job-lifecycle entry points need beyond the generic
 * queue plumbing ({@link JobQueueDeps}) — the out-of-scope engine choice, and
 * the three optional seams. See the module header for why each is injected
 * rather than guessed at. */
export interface RecReadExtraDeps {
  /** Defaults to {@link resolveReadEngineNotImplemented}. */
  resolvePassEngine?: ResolveReadEngine;
  sidecarCall?: RecReadSidecarCall;
  log?: RecReadLog;
  onReadDone?: (event: RecReadDoneEvent) => void;
}

export function recReadRunnerDeps(deps: JobQueueDeps, extra: RecReadExtraDeps): RecReadRunnerDeps {
  return {
    ...runnerDepsFrom(deps),
    sidecarCall: extra.sidecarCall,
    log: extra.log,
    onReadDone: extra.onReadDone,
  };
}

export function openReadRoom(deps: JobQueueDeps): RoomHandle {
  const room = deps.rooms.current();
  if (room === null) throw new Error("No room is open.");
  return room;
}

export interface ReadSource {
  readonly fileName: string;
  readonly stamp: ReadStamp;
  readonly turns: Turn[];
}

export function readSource(room: RoomHandle, fileId: string): ReadSource {
  const fileName = getFileName(room.db, fileId);
  const metaJson = getRecMeta(room.db, fileId);
  if (metaJson === null) throw new Error("That file is not a recording.");
  const meta = parseRecMeta(metaJson);
  const turns = turnsOf(meta);
  if (turns.length === 0) throw new Error("That recording has no transcript to read yet.");
  if (readingNow(room.db, fileId)) throw new Error("That recording is already being read.");
  return { fileName, stamp: readStampOf(meta.segments), turns };
}

export function readPlan(fileId: string, source: ReadSource): ReadPlan {
  return {
    fileId,
    fileName: source.fileName,
    stamp: source.stamp,
    windows: partitionTurns(source.turns, READ_WINDOW_CHARS),
    visibleChars: visibleChars(source.turns),
  };
}

export function readJobId(
  deps: JobQueueDeps,
  roomPath: string,
  plan: ReadPlan,
  steps: readonly Step[],
): string {
  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) throw new Error(ROOM_GONE);
  if (atCapacity(db)) throw new Error(QUEUE_FULL);
  return createJob(db, "rec_read", `Reading ${plan.fileName}`, plan, steps.length);
}

export function startReservedRead(
  deps: JobQueueDeps,
  extra: RecReadExtraDeps,
  jobId: string,
  roomPath: string,
  plan: ReadPlan,
  chatModel: string,
  steps: readonly Step[],
  turns: readonly Turn[],
): void {
  if (!tryReserve(deps.state, jobId)) return;
  const cancel = new CancelFlag();
  deps.cancelState.jobCancels.set(jobId, cancel);
  void spawnRecRead(recReadRunnerDeps(deps, extra), jobId, roomPath, plan, chatModel, steps, 0, cancel, turns);
}

/** Is a read of this recording already queued or running? Two reads writing the
 * same meta would each replace the other's findings. */
export function readingNow(db: Database.Database, fileId: string): boolean {
  return listJobs(db).some((j: Job) => {
    if (j.kind !== "rec_read" || (j.status !== "queued" && j.status !== "running")) {
      return false;
    }
    const planned = asRecord(j.plan)?.fileId;
    return typeof planned === "string" && planned === fileId;
  });
}

/**
 * Start a read of one recording: build the plan, create the job row, and (if
 * the single heavy-work slot is free) drive it. Returns the job id.
 *
 * Refuses in the two cases where reading would be dishonest rather than merely
 * unhelpful: a recording with no words yet, and one already being read (a
 * second job would race the first into the same meta).
 */
export async function startRecRead(
  deps: JobQueueDeps,
  extra: RecReadExtraDeps,
  fileId: string
): Promise<string> {
  const room = openReadRoom(deps);
  const source = readSource(room, fileId);
  const plan = readPlan(fileId, source);
  const { chatModel, lane } = await (extra.resolvePassEngine ?? resolveReadEngineNotImplemented)();
  const steps = buildReadSteps(plan.windows.length, lane);
  const jobId = readJobId(deps, room.path, plan, steps);
  startReservedRead(deps, extra, jobId, room.path, plan, chatModel, steps, source.turns);
  return jobId;
}

export type RowPlan = { kind: "plan"; plan: ReadPlan } | { kind: "error"; message: string };
export type RowTurns = { kind: "turns"; turns: Turn[] } | { kind: "error"; message: string };
export type RowEngine = { kind: "engine"; chatModel: string; lane: Lane } | { kind: "error"; message: string };

export function storedRowPlan(job: Job): RowPlan {
  try {
    return { kind: "plan", plan: parseReadPlan(job.plan) };
  } catch {
    return { kind: "error", message: UNREADABLE_PLAN };
  }
}

export function currentRowTurns(db: Database.Database, plan: ReadPlan): RowTurns {
  const metaJson = getRecMeta(db, plan.fileId);
  if (metaJson === null) {
    return { kind: "error", message: "The recording this read belongs to is no longer in the room." };
  }
  let meta: RecMeta;
  try {
    meta = parseRecMeta(metaJson);
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
  const turns = turnsOf(meta);
  if (!stampsEqual(readStampOf(meta.segments), plan.stamp) || turnsMoved(plan, turns)) {
    return { kind: "error", message: "That recording's transcript changed — read it again." };
  }
  return { kind: "turns", turns };
}

export async function rowEngine(extra: RecReadExtraDeps): Promise<RowEngine> {
  try {
    return { kind: "engine", ...await (extra.resolvePassEngine ?? resolveReadEngineNotImplemented)() };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export function resumedReadCursor(cursor: number, steps: readonly Step[]): number {
  return Math.min(Math.max(Math.trunc(cursor), 0), steps.length);
}

export async function startReadRow(
  extra: RecReadExtraDeps,
  deps: JobQueueDeps,
  job: Job,
  roomPath: string,
  cancel: CancelSignal,
): Promise<RowStartResult> {
  const stored = storedRowPlan(job);
  if (stored.kind === "error") return stored;
  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) return { kind: "error", message: ROOM_GONE };
  const current = currentRowTurns(db, stored.plan);
  if (current.kind === "error") return current;
  const engine = await rowEngine(extra);
  if (engine.kind === "error") return engine;
  const steps = buildReadSteps(stored.plan.windows.length, engine.lane);
  void spawnRecRead(
    recReadRunnerDeps(deps, extra),
    job.id,
    roomPath,
    stored.plan,
    engine.chatModel,
    steps,
    resumedReadCursor(job.cursor, steps),
    cancel,
    current.turns,
  );
  return { kind: "runner" };
}

/**
 * A {@link RowStarter} for the `"rec_read"` job kind — the port of
 * `start_rec_read_row`, and the analogue of `jobQueue.ts`'s own
 * `podcastAudioRowStarter`. Register it into a starters map
 * (`starters.set("rec_read", recReadRowStarter(extra))`) to make a
 * queued/paused row resumable through the normal pump; `KNOWN_JOB_KINDS`
 * already lists `"rec_read"`, so without an entry it falls through to
 * `notImplementedRowStarter`.
 */
export function recReadRowStarter(extra: RecReadExtraDeps = {}): RowStarter {
  return (deps, job, roomPath, cancel) => startReadRow(extra, deps, job, roomPath, cancel);
}
