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
import { readProgressLabel } from "./recReadMerge.js";
import { executeReadStep } from "./recReadSteps.js";
import { RecReadDoneEvent, RecReadRunnerDeps } from "./recReadStorage.js";
import { ReadPlan, Turn } from "./recReadTypes.js";
// =============================================================================
// spawnRecRead (rec_read.rs:672-805)
// =============================================================================

export interface ReadRunResult {
  readonly outcome: RunOutcome;
  readonly lastCursor: number;
}

export function markReadRunning(deps: RecReadRunnerDeps, roomPath: string, jobId: string): void {
  const db = pinnedDb(deps.rooms, roomPath);
  if (db !== null) {
    setJobStatus(db, jobId, "running", null);
  }
}

export function completedReadSteps(cursor: number): Set<number> {
  const done = new Set<number>();
  for (let index = 0; index < cursor; index += 1) {
    done.add(index);
  }
  return done;
}

export function recordReadCheckpoint(
  deps: RecReadRunnerDeps,
  jobId: string,
  roomPath: string,
  doneSet: ReadonlySet<number>
): number {
  const cursor = densePrefix(doneSet);
  const db = pinnedDb(deps.rooms, roomPath);
  if (db !== null) {
    checkpointJob(db, jobId, cursor, {});
  }
  return cursor;
}

export function settledReadOutcome(raw: RunOutcome, cancel: CancelSignal): RunOutcome {
  return raw.kind === "error" && cancel.load() ? { kind: "paused" } : raw;
}

export async function runReadPlan(
  deps: RecReadRunnerDeps,
  jobId: string,
  roomPath: string,
  plan: ReadPlan,
  chatModel: string,
  steps: readonly Step[],
  startCursor: number,
  cancel: CancelSignal,
  turns: readonly Turn[]
): Promise<ReadRunResult> {
  let lastCursor = startCursor;
  const raw = await runPlan(
    steps,
    completedReadSteps(startCursor),
    cancel,
    (step) => executeReadStep(deps, jobId, roomPath, plan, chatModel, turns, step, cancel),
    (doneSet) => {
      lastCursor = recordReadCheckpoint(deps, jobId, roomPath, doneSet);
    },
    (done, total) => {
      emitProgress(deps.sink, jobId, readProgressLabel(plan, done), done, total);
    }
  );
  return { outcome: settledReadOutcome(raw, cancel), lastCursor };
}

export function readTerminalStatus(outcome: RunOutcome): "done" | "paused" | "error" {
  if (outcome.kind === "done") return "done";
  return outcome.kind === "paused" ? "paused" : "error";
}

export function readOutcomeError(outcome: RunOutcome): string | null {
  return outcome.kind === "error" ? outcome.error : null;
}

export function storeReadOutcome(deps: RecReadRunnerDeps, jobId: string, roomPath: string, outcome: RunOutcome): void {
  const db = pinnedDb(deps.rooms, roomPath);
  if (db !== null) {
    setJobStatus(db, jobId, readTerminalStatus(outcome), readOutcomeError(outcome));
  }
}

export function readDoneEvent(fileId: string, outcome: RunOutcome): RecReadDoneEvent {
  if (outcome.kind === "done") return { fileId, ok: true };
  if (outcome.kind === "paused") return { fileId, ok: false };
  return { fileId, ok: false, error: outcome.error };
}

export function emitReadDone(deps: RecReadRunnerDeps, fileId: string, outcome: RunOutcome): void {
  try {
    deps.onReadDone?.(readDoneEvent(fileId, outcome));
  } catch {
    // Best-effort, matching Rust's `let _ = window.emit(..)`.
  }
}

export function terminalReadProgress(
  jobId: string,
  plan: ReadPlan,
  total: number,
  lastCursor: number,
  outcome: RunOutcome
): JobProgressPayload {
  if (outcome.kind === "done") {
    return { jobId, label: `Finished reading "${plan.fileName}"`, done: total, total, finished: true };
  }
  if (outcome.kind === "paused") {
    return { jobId, label: "Paused", done: lastCursor, total, paused: true };
  }
  return { jobId, label: `Stopped — ${outcome.error}`, done: lastCursor, total, failed: true };
}

export async function finishRead(
  deps: RecReadRunnerDeps,
  jobId: string,
  roomPath: string,
  plan: ReadPlan,
  total: number,
  result: ReadRunResult
): Promise<void> {
  storeReadOutcome(deps, jobId, roomPath, result.outcome);
  deps.removeCancelFlag(jobId);
  emitReadDone(deps, plan.fileId, result.outcome);
  deps.sink.emit(terminalReadProgress(jobId, plan, total, result.lastCursor, result.outcome));
  await deps.onSettled(jobId);
}

/**
 * Drive one `rec_read` job's plan to completion: the windows in order (each
 * carrying its thread to the next), then one CPU publish — checkpointing after
 * every wave and landing the row on a terminal status.
 *
 * A Stop pressed mid-model-call surfaces as the step's own error ("STOPPED")
 * rather than a clean pause; it is converted back to `paused` here, exactly as
 * `spawn_rec_read` does.
 *
 * Returns the runner's settled promise for the same reason
 * {@link spawnJobRunner} does — a real caller fires it and moves on; tests await
 * it.
 */
export function spawnRecRead(
  deps: RecReadRunnerDeps,
  jobId: string,
  roomPath: string,
  plan: ReadPlan,
  chatModel: string,
  steps: readonly Step[],
  startCursor: number,
  cancel: CancelSignal,
  turns: readonly Turn[]
): Promise<void> {
  return spawnJobRunner(deps, jobId, roomPath, async () => {
    markReadRunning(deps, roomPath, jobId);
    const total = steps.length;
    emitProgress(deps.sink, jobId, readProgressLabel(plan, startCursor), startCursor, total);
    const result = await runReadPlan(deps, jobId, roomPath, plan, chatModel, steps, startCursor, cancel, turns);
    await finishRead(deps, jobId, roomPath, plan, total, result);
  });
}
