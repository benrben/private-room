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
import { asRecord, coerceReadArtifact, installFindings, isFatal, stampsEqual, turnNumber } from "./recReadMerge.js";
import { mergeFindings, windowText } from "./recReadPlan.js";
import { SidecarJsonError, SidecarJsonOutcome, sidecarErrorSentinel, sidecarJsonCancellable } from "./recReadSidecar.js";
import { REAL_LOG, RecReadStepDeps, loadArtifact, storeArtifact } from "./recReadStorage.js";
import { KEEP_ALIVE_WARM, ReadArtifact, ReadPlan, Turn, defaultReadArtifact, turnsMoved, turnsOf } from "./recReadTypes.js";
// =============================================================================

export const ROOM_GONE = "The room this job belongs to is no longer open.";
export const RECORDING_GONE = "That recording is no longer in the room.";
export const TRANSCRIPT_CHANGED_MID_READ =
  "That recording's transcript changed while it was being read — read it again.";

export type MapThread = { kind: "thread"; thread: string } | { kind: "error"; error: string };
export type MapArtifact = { kind: "artifact"; artifact: ReadArtifact } | { kind: "error"; error: string };

export function mapWindowIndex(plan: ReadPlan, step: Step): { index: number; range: [number, number] } | StepResult {
  const index = turnNumber(asRecord(step.params)?.window) ?? 0;
  const range = plan.windows[index];
  return range === undefined
    ? { ok: false, error: `window ${index} is not in the plan` }
    : { index, range };
}

export function isStepFailure(value: unknown): value is StepResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

export function precedingThread(
  deps: RecReadStepDeps,
  jobId: string,
  roomPath: string,
  index: number,
): MapThread {
  if (index === 0) return { kind: "thread", thread: "" };
  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) return { kind: "error", error: ROOM_GONE };
  return { kind: "thread", thread: loadArtifact(db, jobId, index - 1)?.thread ?? "" };
}

export function readMapRequest(
  plan: ReadPlan,
  model: string,
  index: number,
  thread: string,
  turns: readonly Turn[],
  range: readonly [number, number],
): Record<string, unknown> {
  return {
    model,
    base_url: resolvedBaseUrl(),
    file_name: plan.fileName,
    part: index,
    total: plan.windows.length,
    thread,
    turns: windowText(turns, range),
    keep_alive: KEEP_ALIVE_WARM,
  };
}

export function sidecarMapError(outcome: SidecarJsonOutcome, model: string, thread: string): MapArtifact {
  const message = sidecarErrorSentinel((outcome as { kind: "error"; error: SidecarJsonError }).error, model);
  if (isFatal(message)) return { kind: "error", error: message };
  return { kind: "artifact", artifact: { ...defaultReadArtifact(), thread, skipped: true } };
}

export async function mappedArtifact(
  deps: RecReadStepDeps,
  plan: ReadPlan,
  model: string,
  index: number,
  thread: string,
  turns: readonly Turn[],
  range: readonly [number, number],
  cancel: CancelSignal,
): Promise<MapArtifact> {
  const call = deps.sidecarCall ?? sidecarJsonCancellable;
  const outcome = await call("/rec_read_map", readMapRequest(plan, model, index, thread, turns, range), cancel);
  if (outcome.kind === "cancelled") return { kind: "error", error: "STOPPED" };
  if (outcome.kind === "value") return { kind: "artifact", artifact: coerceReadArtifact(outcome.value) };
  return sidecarMapError(outcome, model, thread);
}

export async function executeMapStep(
  deps: RecReadStepDeps,
  jobId: string,
  roomPath: string,
  plan: ReadPlan,
  model: string,
  turns: readonly Turn[],
  step: Step,
  cancel: CancelSignal
): Promise<StepResult> {
  const window = mapWindowIndex(plan, step);
  if (isStepFailure(window)) return window;
  const thread = precedingThread(deps, jobId, roomPath, window.index);
  if (thread.kind === "error") return { ok: false, error: thread.error };
  const mapped = await mappedArtifact(
    deps,
    plan,
    model,
    window.index,
    thread.thread,
    turns,
    window.range,
    cancel,
  );
  if (mapped.kind === "error") return { ok: false, error: mapped.error };

  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) return { ok: false, error: ROOM_GONE };
  storeArtifact(db, jobId, window.index, mapped.artifact);
  return { ok: true };
}

/** Synchronous by construction: nothing here awaits, so the meta this step
 * reads cannot be replaced between the read and the write it derives. */
export function publishedArtifacts(db: Database.Database, jobId: string, windows: number): ReadArtifact[] {
  const found: ReadArtifact[] = [];
  for (let index = 0; index < windows; index++) {
    const artifact = loadArtifact(db, jobId, index);
    if (artifact !== null) found.push(artifact);
  }
  return found;
}

export type PublishMeta = { kind: "meta"; meta: RecMeta } | { kind: "error"; error: string };

export function publishMeta(db: Database.Database, fileId: string): PublishMeta {
  const json = getRecMeta(db, fileId);
  if (json === null) return { kind: "error", error: RECORDING_GONE };
  try {
    return { kind: "meta", meta: parseRecMeta(json) };
  } catch (err) {
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

export function planMovedSinceRead(plan: ReadPlan, meta: RecMeta): boolean {
  const turns = turnsOf(meta);
  return !stampsEqual(readStampOf(meta.segments), plan.stamp) || turnsMoved(plan, turns);
}

export function allReadWindowsSkipped(windows: number, artifacts: readonly ReadArtifact[]): boolean {
  return windows > 0 && windows === artifacts.filter((artifact) => artifact.skipped).length;
}

export function noReadablePartsError(plan: ReadPlan): StepResult {
  return {
    ok: false,
    error:
      `No part of "${plan.fileName}" could be read — the model answered for ` +
      `none of the ${plan.windows.length} parts. Read it again.`,
  };
}

export function publishValidation(
  plan: ReadPlan,
  meta: RecMeta,
  artifacts: readonly ReadArtifact[],
): StepResult | null {
  if (planMovedSinceRead(plan, meta)) {
    return { ok: false, error: TRANSCRIPT_CHANGED_MID_READ };
  }
  if (allReadWindowsSkipped(plan.windows.length, artifacts)) {
    return noReadablePartsError(plan);
  }
  return null;
}

export function writePublishedFindings(
  db: Database.Database,
  plan: ReadPlan,
  meta: RecMeta,
  artifacts: readonly ReadArtifact[],
): void {
  const turns = turnsOf(meta);
  const speakers = new Set(turns.map((turn) => turn.who));
  const stamp = readStampOf(meta.segments);
  const { chapters, highlights, notes } = mergeFindings(artifacts, turns, speakers);
  installFindings(meta, chapters, highlights, notes, stamp);
  setFileExtractedText(db, plan.fileId, transcriptText(meta));
  setRecMeta(db, plan.fileId, JSON.stringify(meta));
}

export function warnIncompleteRead(
  deps: RecReadStepDeps,
  plan: ReadPlan,
  artifacts: readonly ReadArtifact[],
): void {
  const skipped = artifacts.filter((artifact) => artifact.skipped).length;
  if (skipped === 0) return;
  (deps.log ?? REAL_LOG).warn("rec_read_incomplete", [
    ["file", obs.id(plan.fileName)],
    ["skipped", obs.count(skipped)],
    ["parts", obs.count(plan.windows.length)],
  ]);
}

export function executePublishStep(
  deps: RecReadStepDeps,
  jobId: string,
  roomPath: string,
  plan: ReadPlan
): StepResult {
  const readDb = pinnedDb(deps.rooms, roomPath);
  if (readDb === null) return { ok: false, error: ROOM_GONE };
  const found = publishedArtifacts(readDb, jobId, plan.windows.length);

  const metaDb = pinnedDb(deps.rooms, roomPath);
  if (metaDb === null) return { ok: false, error: ROOM_GONE };
  const loaded = publishMeta(metaDb, plan.fileId);
  if (loaded.kind === "error") return { ok: false, error: loaded.error };
  const validation = publishValidation(plan, loaded.meta, found);
  if (validation !== null) return validation;

  const writeDb = pinnedDb(deps.rooms, roomPath);
  if (writeDb === null) return { ok: false, error: ROOM_GONE };
  writePublishedFindings(writeDb, plan, loaded.meta, found);
  warnIncompleteRead(deps, plan, found);
  return { ok: true };
}

/**
 * Execute one step. `turns` is the whole recording's turn list, shared across
 * steps and re-derived once per run; `roomPath` pins every room access to the
 * room the read was started in, so a room closed or swapped mid-run parks the
 * job instead of receiving another room's findings.
 */
export async function executeReadStep(
  deps: RecReadStepDeps,
  jobId: string,
  roomPath: string,
  plan: ReadPlan,
  model: string,
  turns: readonly Turn[],
  step: Step,
  cancel: CancelSignal
): Promise<StepResult> {
  if (step.kind === "map") {
    return executeMapStep(deps, jobId, roomPath, plan, model, turns, step, cancel);
  }
  if (step.kind === "publish") {
    return executePublishStep(deps, jobId, roomPath, plan);
  }
  return { ok: false, error: `unknown read step "${step.kind}"` };
}
