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
import { installFindings } from "./recReadMerge.js";
// =============================================================================
// constants (rec_read.rs:38-54)
// =============================================================================

/** Transcript characters per model call. Far smaller than `file_pass`'s 32K:
 * that window is sized for "read this prose and take notes", while this one
 * asks for STRUCTURED findings with a number attached to each. A window holding
 * forty minutes of talk invites a small model to return a dozen vague items
 * with drifting numbers; ~12K (roughly ten minutes of speech) keeps every
 * finding close to the words that produced it. */
export const READ_WINDOW_CHARS = 12_000;

/** Chapters closer together than this are one chapter (30 s). Without a floor a
 * model asked for sections happily returns one per turn, which is not a table
 * of contents — it is the transcript with extra steps. */
export const MIN_CHAPTER_GAP_CS = 3_000;

/** The most findings of one kind kept from a single window. A model that starts
 * listing every sentence is not reading, and the tabs must not become a second
 * transcript. */
export const MAX_PER_WINDOW = 12;

/** `commands::models::KEEP_ALIVE_WARM` (`commands/models.rs:183`) — no
 * `models.ts` exists in this migration yet, so the literal is reproduced here
 * rather than guessed at differently. */
export const KEEP_ALIVE_WARM = "30m";

// =============================================================================
// Turn / ReadPlan / ReadArtifact (rec_read.rs:56-148)
// =============================================================================

/** One speaker turn as the model is shown it, and as the publish step resolves
 * numbers against. Derived from the recording's segments; never persisted. */
export interface Turn {
  t0: number;
  t1: number;
  who: string;
  text: string;
}

/** The immutable plan. Stores the windows and a fingerprint of the source, so a
 * resumed job that finds different words refuses rather than writing findings
 * about a transcript that no longer exists. */
export interface ReadPlan {
  fileId: string;
  fileName: string;
  stamp: ReadStamp;
  /** Half-open turn-index ranges, consecutive and gapless. */
  windows: Array<[number, number]>;
  /** How many UTF-8 BYTES of visible transcript the plan was built from. `null`
   * on plans written before this field existed (Rust's `Option<usize>` with
   * `#[serde(default)]`, which serializes `None` as `null`) — those keep the
   * older, weaker check rather than being refused wholesale. See
   * {@link turnsMoved}. */
  visibleChars: number | null;
}

export interface FoundChapter {
  turn: number;
  title: string;
}

export interface FoundHighlight {
  turn: number;
  /** Last turn of the span; treated as `turn` when missing or before it. */
  until: number;
}

export interface FoundNote {
  turn: number;
  kind: string;
  text: string;
  who: string | null;
}

/** What one window's model call found. Turn NUMBERS, not times — see the module
 * header. Absent/garbage fields default rather than failing the window: a
 * partial answer is worth keeping, and `skipped` is how a lost window is
 * reported honestly. */
export interface ReadArtifact {
  chapters: FoundChapter[];
  highlights: FoundHighlight[];
  notes: FoundNote[];
  thread: string;
  skipped: boolean;
  /** Declared for parity with the Rust struct, which never reads or writes it
   * either: the publish step's idempotency comes from {@link installFindings}
   * REPLACING the room's items every time, not from checking a flag. Preserved
   * as inert rather than "completed". */
  published: boolean;
}

export function defaultReadArtifact(): ReadArtifact {
  return { chapters: [], highlights: [], notes: [], thread: "", skipped: false, published: false };
}

// =============================================================================
// turnsOf / visibleChars / turnsMoved (rec_read.rs:83-101, 150-166)
// =============================================================================

/** The turns of a recording, in order, as the model will see them. Deleted
 * words are already gone ({@link segmentVisibleText}), and an empty turn is
 * dropped — it is a silence, not something to read. */
export function turnsOf(meta: RecMeta): Turn[] {
  const out: Turn[] = [];
  for (const s of meta.segments) {
    const text = segmentVisibleText(s);
    if (text !== "") {
      out.push({ t0: s.t0, t1: s.t1, who: displaySpeaker(meta, s.speaker), text });
    }
  }
  return out;
}

/** Bytes of visible text across every turn — Rust's `t.text.len()` summed,
 * which is UTF-8 BYTE length (`String::len`), not a character count. Matched
 * with `Buffer.byteLength` exactly as `recFormat.ts`'s `readStampOf` does, for
 * the same reason: a Hebrew transcript must move this number by precisely as
 * much as the Rust original would, or a plan written by one and checked by the
 * other reads as stale (or fresh) on sight. */
export function visibleChars(turns: readonly Turn[]): number {
  let total = 0;
  for (const t of turns) {
    total += Buffer.byteLength(t.text, "utf8");
  }
  return total;
}

/**
 * Have the turns moved out from under a plan built on them?
 *
 * `ReadStamp` counts SEGMENTS and their raw text, and deleting words changes
 * neither: "Delete from recording" marks the words `del` and leaves the segment
 * row and its `text` exactly as they were. But {@link turnsOf} drops a phrase
 * whose words are all deleted, so the turn list the publish step resolves
 * numbers against was one turn SHORTER than the one the model was shown — and
 * every chapter, note and highlight after the deleted phrase was written onto
 * the preceding speaker's sentence. The turn count is derivable from any plan
 * (the windows are gapless and cover every turn), so this check protects old
 * plans too; `visibleChars` adds the words themselves for plans that carry it.
 */
export function turnsMoved(plan: ReadPlan, turns: readonly Turn[]): boolean {
  const last = plan.windows[plan.windows.length - 1];
  const planned = last === undefined ? 0 : last[1];
  return (
    turns.length !== planned ||
    (plan.visibleChars !== null && plan.visibleChars !== visibleChars(turns))
  );
}
