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
import { FoundHighlight, FoundNote, MAX_PER_WINDOW, MIN_CHAPTER_GAP_CS, ReadArtifact, Turn, visibleChars } from "./recReadTypes.js";
// =============================================================================
// partitionTurns / windowText (rec_read.rs:168-207)
// =============================================================================

/**
 * Split turns into consecutive windows of at most `target` characters.
 *
 * GUARANTEES, and the tests exist for them: the windows are gapless, in order,
 * and every turn is in exactly one. A turn longer than `target` gets a window
 * to itself rather than being cut — coverage beats tidiness, and this is the
 * exact shape of the `#minutes` bug, where a clamp meant a recording was read
 * for its first five minutes and reported as read.
 *
 * The `i > start` guard is what makes a turn atomic: the FIRST turn of a window
 * is admitted whatever it costs, so an over-budget turn opens (and closes) a
 * window of its own instead of being split across two.
 *
 * `text`/`who` are measured in UTF-8 BYTES (`Buffer.byteLength`), matching
 * Rust's `String::len()` — see {@link visibleChars} on why a plain `.length`
 * would move this budget differently for a Hebrew transcript.
 */
export function partitionTurns(turns: readonly Turn[], target: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  let chars = 0;
  for (const [i, t] of turns.entries()) {
    // + the "#n [m:ss] who: " frame
    const len = Buffer.byteLength(t.text, "utf8") + Buffer.byteLength(t.who, "utf8") + 16;
    if (i > start && chars + len > target) {
      out.push([start, i]);
      start = i;
      chars = 0;
    }
    chars += len;
  }
  if (start < turns.length) {
    out.push([start, turns.length]);
  }
  return out;
}

/** The window as the model reads it. Numbers are GLOBAL turn indices, so a
 * finding from window 3 resolves the same way as one from window 0 and the
 * publish step never has to know which window an answer came from. The range is
 * clamped to the real turn list rather than trusted: a stored plan is untrusted
 * input, and an out-of-range window must render fewer lines, never throw. */
export function windowText(turns: readonly Turn[], range: readonly [number, number]): string {
  const start = Math.max(range[0], 0);
  const end = Math.min(range[1], turns.length);
  let out = "";
  for (const [k, t] of turns.slice(start, end).entries()) {
    out += `#${start + k} ${formatStamp(t.t0)} ${t.who}: ${t.text}\n`;
  }
  return out;
}

// =============================================================================
// norm / readNoteKind (rec_read.rs:209-221)
// =============================================================================

export function norm(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "")
    .join(" ");
}

/**
 * The MODEL-facing kind normalizer — `rec_read.rs`'s own private `note_kind`,
 * deliberately distinct from `recFormat.ts`'s `noteKindOf`, which is the
 * USER-facing one (`rec_note_add`'s `match … _ => Point`: an unrecognized kind
 * a PERSON typed defaults to Point). Here an unrecognized kind returns `null`
 * and {@link mergeFindings} DROPS the whole finding rather than reclassifying
 * it — a model does not get the benefit of the doubt a person picking from a
 * dropdown gets. It also accepts a wider synonym set ("action_item", "task",
 * "open_question", "key_point", "summary"), since a model's own wording varies
 * more than a dropdown's. Conflating the two would be a real fidelity bug.
 */
export function readNoteKind(s: string): NoteKind | null {
  return READ_NOTE_KINDS[s.trim().toLowerCase()] ?? null;
}

export const READ_NOTE_KINDS: Record<string, NoteKind> = {
  decision: "decision",
  action: "action",
  action_item: "action",
  task: "action",
  question: "question",
  open_question: "question",
  point: "point",
  key_point: "point",
  summary: "point",
};

/** Rust's `title.chars().take(n).collect()` — Unicode CODE POINTS, not UTF-16
 * code units, so an emoji at the boundary is never split into half a surrogate
 * pair. */
export function takeChars(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

// =============================================================================
// mergeFindings — THE reduce, and the timestamp guarantee (rec_read.rs:223-332)
// =============================================================================

export const BY_ROOM: By = "room";

export function turnTime(turns: readonly Turn[], index: number): number | undefined {
  return turns[index]?.t0;
}

export function collectRawChapters(found: readonly ReadArtifact[], turns: readonly Turn[]): RecChapter[] {
  const raw: RecChapter[] = [];
  for (const artifact of found) {
    for (const chapter of artifact.chapters.slice(0, MAX_PER_WINDOW)) {
      const t0 = turnTime(turns, chapter.turn);
      const title = chapter.title.trim();
      if (t0 === undefined || title === "") continue;
      raw.push({ id: randomUUID(), t0, title: takeChars(title, 80), by: BY_ROOM });
    }
  }
  return raw;
}

export function chapterIsCrowded(chapters: readonly RecChapter[], chapter: RecChapter): boolean {
  const previous = chapters[chapters.length - 1];
  return previous !== undefined && chapter.t0 - previous.t0 < MIN_CHAPTER_GAP_CS;
}

export function hasRepeatedChapter(chapters: readonly RecChapter[], chapter: RecChapter): boolean {
  return chapters.some((previous) => norm(previous.title) === norm(chapter.title));
}

export function mergeChapters(found: readonly ReadArtifact[], turns: readonly Turn[]): RecChapter[] {
  const raw = collectRawChapters(found, turns);
  raw.sort((left, right) => left.t0 - right.t0);
  const chapters: RecChapter[] = [];
  for (const chapter of raw) {
    if (!chapterIsCrowded(chapters, chapter) && !hasRepeatedChapter(chapters, chapter)) {
      chapters.push(chapter);
    }
  }
  return chapters;
}

export function highlightEnd(
  turns: readonly Turn[],
  highlight: FoundHighlight,
  t0: number,
): number {
  const end = turns[Math.max(highlight.until, highlight.turn)];
  if (end === undefined) return t0;
  return Math.max(end.t1, t0);
}

export function collectHighlightSpans(found: readonly ReadArtifact[], turns: readonly Turn[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const artifact of found) {
    for (const highlight of artifact.highlights.slice(0, MAX_PER_WINDOW)) {
      const t0 = turnTime(turns, highlight.turn);
      if (t0 === undefined) continue;
      // `until` before `turn` means the span is the turn itself; an `until`
      // past the transcript falls back to this turn's own end rather than
      // stretching the mark to a moment nobody spoke at.
      const t1 = highlightEnd(turns, highlight, t0);
      spans.push([t0, t1]);
    }
  }
  return spans;
}

export function mergeHighlights(found: readonly ReadArtifact[], turns: readonly Turn[]): RecHighlight[] {
  const spans = collectHighlightSpans(found, turns);
  spans.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const highlights: RecHighlight[] = [];
  for (const [t0, t1] of spans) {
    const previous = highlights[highlights.length - 1];
    if (previous !== undefined && t0 <= previous.t1) {
      previous.t1 = Math.max(previous.t1, t1);
    } else {
      highlights.push({ id: randomUUID(), t0, t1, by: BY_ROOM });
    }
  }
  return highlights;
}

export interface ReadNoteCandidate {
  readonly t0: number;
  readonly kind: NoteKind;
  readonly text: string;
  readonly rawKind: string;
  readonly who: string | null;
}

export function readNoteCandidate(note: FoundNote, turns: readonly Turn[]): ReadNoteCandidate | undefined {
  const t0 = turnTime(turns, note.turn);
  const kind = readNoteKind(note.kind);
  if (t0 === undefined || kind === null) return undefined;
  const text = note.text.trim();
  if (text === "") return undefined;
  return { t0, kind, text, rawKind: note.kind.toLowerCase(), who: note.who };
}

export function takeWindowNote(perKind: Map<string, number>, rawKind: string): boolean {
  const seen = perKind.get(rawKind) ?? 0;
  if (seen >= MAX_PER_WINDOW) return false;
  perKind.set(rawKind, seen + 1);
  return true;
}

export function hasRepeatedNote(notes: readonly RecNote[], candidate: ReadNoteCandidate): boolean {
  return notes.some((note) => note.kind === candidate.kind && norm(note.text) === norm(candidate.text));
}

export function knownNoteAuthor(who: string | null, speakers: ReadonlySet<string>): string | null {
  const name = who === null ? "" : who.trim();
  return name !== "" && speakers.has(name) ? name : null;
}

export function appendWindowNote(
  note: FoundNote,
  turns: readonly Turn[],
  speakers: ReadonlySet<string>,
  perKind: Map<string, number>,
  notes: RecNote[],
): void {
  const candidate = readNoteCandidate(note, turns);
  if (candidate === undefined) return;
  if (!takeWindowNote(perKind, candidate.rawKind)) return;
  if (hasRepeatedNote(notes, candidate)) return;
  notes.push({
    id: randomUUID(),
    t0: candidate.t0,
    kind: candidate.kind,
    text: takeChars(candidate.text, 400),
    who: knownNoteAuthor(candidate.who, speakers),
    by: BY_ROOM,
  });
}

export function mergeNotes(
  found: readonly ReadArtifact[],
  turns: readonly Turn[],
  speakers: ReadonlySet<string>,
): RecNote[] {
  const notes: RecNote[] = [];
  for (const artifact of found) {
    // Reset per WINDOW, and key it by the model's own raw lowercased kind.
    // "action" and "action_item" therefore each get their own budget even
    // though both normalize to the same NoteKind, matching the Rust port.
    const perKind = new Map<string, number>();
    for (const note of artifact.notes) appendWindowNote(note, turns, speakers, perKind, notes);
  }
  notes.sort((left, right) => left.t0 - right.t0);
  return notes;
}

/**
 * Turn every window's findings into the recording's annotations: resolve turn
 * numbers to real times, drop what cannot be trusted, dedupe, and sort.
 *
 * The whole reduce, and it is ORDINARY CODE — no model call. Rules, each of
 * which exists because the alternative is a confident wrong claim on screen:
 *
 * - A turn number outside the transcript is **dropped** (`turns[n]` is
 *   `undefined`). This is what makes a hallucinated time impossible.
 * - An empty title/text is dropped — a blank chapter is worse than none.
 * - `who` is kept only when that name actually speaks in this recording;
 *   otherwise the note survives without it. A model must not be able to
 *   attribute an action item to a colleague who was never there.
 * - Same-kind notes with the same words are one note. Windows overlap in
 *   subject even when they do not overlap in turns.
 * - Chapters within {@link MIN_CHAPTER_GAP_CS} collapse to the first.
 * - Overlapping highlights merge into one span.
 */
export function mergeFindings(
  found: readonly ReadArtifact[],
  turns: readonly Turn[],
  speakers: ReadonlySet<string>
): { chapters: RecChapter[]; highlights: RecHighlight[]; notes: RecNote[] } {
  return {
    chapters: mergeChapters(found, turns),
    highlights: mergeHighlights(found, turns),
    notes: mergeNotes(found, turns, speakers),
  };
}
