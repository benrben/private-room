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
import { coerceReadArtifact } from "./recReadMerge.js";
import { spawnRecRead } from "./recReadRunner.js";
import { RecReadSidecarCall, sidecarJsonCancellable } from "./recReadSidecar.js";
import { executeReadStep } from "./recReadSteps.js";
import { ReadArtifact } from "./recReadTypes.js";
// =============================================================================
// injected seams
// =============================================================================

/** Where the "some windows could not be read" warning goes. Injectable and
 * defaulting to the real host log, the same convention `db-host/jobs.ts` uses
 * for its own `JobStatusLog`. */
export interface RecReadLog {
  warn: typeof obs.warn;
}

export const REAL_LOG: RecReadLog = obs;

/** Which model + {@link Lane} a background pass runs on — Rust's
 * `resolve_pass_engine` (`commands/jobs.rs:1247`), which has no Electron port.
 * See the module header. */
export type ResolveReadEngine = () => Promise<{ chatModel: string; lane: Lane }>;

/** The labeled reason the stubbed resolver fails with. Exported so a caller or
 * a test can recognize it without hand-copying the string. */
export const RESOLVE_READ_ENGINE_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: engine routing (resolve_pass_engine — the model_setting " +
  "read, ollama::list_models and capabilities::runs_on_this_mac behind it) has " +
  "no Electron port yet, so a recording read cannot choose a model.";

/** The stub {@link ResolveReadEngine} every entry point falls back to when no
 * real resolver is supplied — "stub, don't fake": a clearly-labeled failure,
 * never a fabricated model choice that would send a room's meeting transcript
 * to whatever happens to be first in a hardcoded list. */
export const resolveReadEngineNotImplemented: ResolveReadEngine = () =>
  Promise.reject(new Error(RESOLVE_READ_ENGINE_NOT_IMPLEMENTED));

/** Rust's `window.emit("rec-read-done", …)` payload — the file-scoped
 * completion signal a viewer showing "Reading this recording…" listens for.
 * EVERY outcome is terminal for that viewer, and only Done used to say so: a
 * read that failed or was stopped left the Notes / Highlights / Chapters tabs
 * reading "Reading this recording…" and the button disabled until the file was
 * closed and reopened. */
export interface RecReadDoneEvent {
  fileId: string;
  ok: boolean;
  error?: string;
}

/** What {@link executeReadStep} needs: where the open room is, plus the two
 * seams a test replaces. */
export interface RecReadStepDeps {
  rooms: RoomSource;
  /** Defaults to {@link sidecarJsonCancellable}. */
  sidecarCall?: RecReadSidecarCall;
  /** Defaults to the real `obs` sink. */
  log?: RecReadLog;
}

/** {@link RecReadStepDeps} plus the generic runner plumbing — the shape
 * {@link spawnRecRead} takes, matching `jobs.ts`'s own
 * `SpawnPodcastAudioDeps extends JobRunnerDeps` convention. */
export interface RecReadRunnerDeps extends JobRunnerDeps, RecReadStepDeps {
  /** Best-effort — never allowed to fail the runner, matching Rust's own
   * `let _ = window.emit(..)`. */
  onReadDone?: (event: RecReadDoneEvent) => void;
}

// =============================================================================
// job-artifact glue (rec_read.rs:383-399)
// =============================================================================

export function loadArtifact(db: Database.Database, jobId: string, stepId: number): ReadArtifact | null {
  const raw = getJobArtifact(db, jobId, stepId);
  if (raw === null) {
    return null;
  }
  try {
    return coerceReadArtifact(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function storeArtifact(
  db: Database.Database,
  jobId: string,
  stepId: number,
  a: ReadArtifact
): void {
  putJobArtifact(db, jobId, stepId, JSON.stringify(a));
}

// =============================================================================
// executeReadStep — map / publish (rec_read.rs:407-545)
