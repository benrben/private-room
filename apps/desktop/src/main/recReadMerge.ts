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
import { mergeFindings } from "./recReadPlan.js";
import { FoundChapter, FoundHighlight, FoundNote, ReadArtifact, ReadPlan, defaultReadArtifact, visibleChars } from "./recReadTypes.js";
// =============================================================================
// installFindings (rec_read.rs:334-358)
// =============================================================================

/**
 * Replace what the room found last time, keep every item the user owns.
 *
 * This is the "Read again" rule, and it is the reason `By` exists: editing an
 * item makes it yours, and yours is never overwritten by a later pass. Mutates
 * `meta` in place, matching Rust's `&mut RecMeta`.
 */
export function installFindings(
  meta: RecMeta,
  chapters: readonly RecChapter[],
  highlights: readonly RecHighlight[],
  notes: readonly RecNote[],
  stamp: ReadStamp
): void {
  meta.chapters = meta.chapters.filter((c) => c.by === "you").concat(chapters);
  meta.chapters.sort((a, b) => a.t0 - b.t0);

  meta.highlights = meta.highlights.filter((h) => h.by === "you").concat(highlights);
  meta.highlights.sort((a, b) => a.t0 - b.t0);

  meta.notes = meta.notes.filter((n) => n.by === "you").concat(notes);
  meta.notes.sort((a, b) => a.t0 - b.t0);

  meta.readOf = stamp;
}

// =============================================================================
// buildReadSteps / isFatal / readProgressLabel
// =============================================================================

/** The step DAG: the windows in order (each carrying its thread to the next),
 * then one CPU publish. Pure and deterministic, so start and resume derive an
 * identical plan — the property the runner's `0..cursor` seeding depends on. */
export function buildReadSteps(nWindows: number, modelLane: Lane): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < nWindows; i++) {
    steps.push({
      id: i,
      lane: modelLane,
      kind: "map",
      params: { window: i },
      dependsOn: i === 0 ? [] : [i - 1],
    });
  }
  const inputs = Array.from({ length: nWindows }, (_, i) => i);
  steps.push({ id: nWindows, lane: "cpu", kind: "publish", params: { inputs }, dependsOn: inputs });
  return steps;
}

/** A hard engine failure parks the job for Resume; anything else is a one-off
 * the read survives with that window marked skipped. */
export function isFatal(e: string): boolean {
  return e === "OLLAMA_DOWN" || e.startsWith("MODEL_MISSING");
}

/** The progress card's line: which part of the meeting is being read now. */
export function readProgressLabel(plan: ReadPlan, done: number): string {
  const n = plan.windows.length;
  return done < n
    ? `Reading part ${done + 1} of ${n} of "${plan.fileName}"`
    : `Writing what it found in "${plan.fileName}"`;
}

// =============================================================================
// untrusted-JSON coercion
// =============================================================================

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** A model-supplied turn NUMBER, or `null` if the field is not one. Rust's
 * `turn: usize` carries no `#[serde(default)]`, so a missing or non-integral
 * turn fails the deserialize outright — it is never defaulted. Reproduced here
 * as "this finding has no number", which {@link coerceReadArtifact} turns into
 * "drop this finding". Defaulting it to 0 instead would pin a finding the model
 * never located onto the recording's opening seconds, which is exactly the
 * fabricated-moment failure this module exists to prevent. */
export function turnNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

export function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

export function coerceFoundChapter(v: unknown): FoundChapter | null {
  const o = asRecord(v);
  if (o === null) {
    return null;
  }
  const turn = turnNumber(o.turn);
  return turn === null ? null : { turn, title: stringOr(o.title, "") };
}

export function coerceFoundHighlight(v: unknown): FoundHighlight | null {
  const o = asRecord(v);
  if (o === null) {
    return null;
  }
  const turn = turnNumber(o.turn);
  if (turn === null) {
    return null;
  }
  // Rust's `#[serde(default)] until: usize` — absent is 0, and `mergeFindings`'
  // own `until.max(turn)` is what turns that back into "the turn itself".
  return { turn, until: turnNumber(o.until) ?? 0 };
}

export function coerceFoundNote(v: unknown): FoundNote | null {
  const o = asRecord(v);
  if (o === null) {
    return null;
  }
  const turn = turnNumber(o.turn);
  return turn === null
    ? null
    : {
        turn,
        kind: stringOr(o.kind, ""),
        text: stringOr(o.text, ""),
        who: typeof o.who === "string" ? o.who : null,
      };
}

export function coerceList<T>(v: unknown, one: (x: unknown) => T | null): T[] {
  if (!Array.isArray(v)) {
    return [];
  }
  const out: T[] = [];
  for (const item of v) {
    const c = one(item);
    if (c !== null) {
      out.push(c);
    }
  }
  return out;
}

/**
 * Coerce an untrusted JSON value (the sidecar's raw `/rec_read_map` response,
 * or a stored `job_artifacts` blob) into a {@link ReadArtifact}.
 *
 * DEVIATION from Rust's `serde_json::from_value(v).unwrap_or_default()`, which
 * is ALL-OR-NOTHING: one malformed item anywhere fails the whole typed
 * deserialize and every field — `thread` included — silently becomes empty.
 * This port coerces PER ITEM: a malformed chapter is dropped, its siblings and
 * the window's `thread`/`skipped` are kept. That is a strictly more forgiving
 * reading of the same untrusted JSON and it cannot weaken the timestamp
 * guarantee, because a finding is only ever kept when it carries a real whole
 * number of its own (see {@link turnNumber}) AND that number indexes a real
 * turn (see {@link mergeFindings}).
 */
export function coerceReadArtifact(value: unknown): ReadArtifact {
  const o = asRecord(value);
  if (o === null) {
    return defaultReadArtifact();
  }
  return {
    chapters: coerceList(o.chapters, coerceFoundChapter),
    highlights: coerceList(o.highlights, coerceFoundHighlight),
    notes: coerceList(o.notes, coerceFoundNote),
    thread: stringOr(o.thread, ""),
    skipped: o.skipped === true,
    published: o.published === true,
  };
}

export function unreadablePlan(): never {
  throw new Error(UNREADABLE_PLAN);
}

export function requiredPlanRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return record === null ? unreadablePlan() : record;
}

export function requiredPlanString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : unreadablePlan();
}

export function requiredPlanNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : unreadablePlan();
}

export function readPlanStamp(record: Record<string, unknown>): ReadStamp {
  const stamp = requiredPlanRecord(record.stamp);
  return { turns: requiredPlanNumber(stamp, "turns"), chars: requiredPlanNumber(stamp, "chars") };
}

export function readPlanWindow(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return unreadablePlan();
  const [start, end] = value;
  if (typeof start !== "number" || typeof end !== "number") return unreadablePlan();
  return [start, end];
}

export function readPlanWindows(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return unreadablePlan();
  const windows: Array<[number, number]> = [];
  for (const window of value) windows.push(readPlanWindow(window));
  return windows;
}

/** Shape-check a stored `jobs.plan` value into a {@link ReadPlan}, throwing on
 * any structural violation — the caller turns that into {@link UNREADABLE_PLAN},
 * mirroring `serde_json::from_value::<ReadPlan>(..).map_err(|_| "This job's
 * plan is unreadable.")`. */
export function parseReadPlan(value: unknown): ReadPlan {
  const record = requiredPlanRecord(value);
  return {
    fileId: requiredPlanString(record, "fileId"),
    fileName: requiredPlanString(record, "fileName"),
    stamp: readPlanStamp(record),
    windows: readPlanWindows(record.windows),
    visibleChars: typeof record.visibleChars === "number" ? record.visibleChars : null,
  };
}

export function stampsEqual(a: ReadStamp, b: ReadStamp): boolean {
  return a.turns === b.turns && a.chars === b.chars;
}
