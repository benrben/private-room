/**
 * The reading pass: the room reads a recording and writes what happened in
 * it — chapters, highlights, and notes (decisions, action items, open
 * questions, key points).
 *
 * Port of `src-tauri/src/commands/jobs/rec_read.rs` (1046 lines, including its
 * `#[cfg(test)] mod tests`, all seven fixtures of which are reproduced in
 * `recRead.test.ts`).
 *
 * Runs by itself when a recording is stopped, in the background for recordings
 * the room already had, and from the "Read this recording" button.
 *
 * Shape (a simpler `file_pass`, and the differences are the point):
 *   1. {@link partitionTurns} splits the transcript into consecutive windows of
 *      WHOLE speaker turns (plan-time, pure). A turn is atomic — half a
 *      sentence in each of two windows would be read twice and understood
 *      neither time.
 *   2. N chained "map" steps walk the meeting IN ORDER, each receiving its
 *      turns plus the short `thread` carried from the previous step. Each
 *      writes an artifact.
 *   3. **No compose step.** `file_pass` needs one because a document's sections
 *      have to be written; here the findings are already local to their window,
 *      so the reduce is {@link mergeFindings} — ordinary code. That is
 *      deliberate: `file_pass`'s own header records a whole-file model fold
 *      collapsing on a small local model and losing an 850 KB book's chapters.
 *      Nothing here may reintroduce a global model fold.
 *   4. A "publish" step (no model) resolves turn numbers to times, merges, and
 *      writes into the recording's meta.
 *
 * **THE PROPERTY THIS FILE EXISTS TO PRESERVE — the model never states a
 * time.** It answers with the turn NUMBER it was shown (`#12`), and
 * {@link mergeFindings} converts that to the exact centisecond of that turn by
 * a plain array index into the REAL turn list. A number outside that list is
 * DROPPED — not clamped, not wrapped, not resolved to a "nearest" turn, and
 * never defaulted to turn 0. So a hallucinated timestamp cannot exist: the
 * worst case is a finding attached to the wrong REAL moment, never a mark at a
 * moment that never happened. {@link coerceReadArtifact} is part of that
 * guarantee too — a finding whose `turn` is missing or not a whole number is
 * discarded rather than given a number it never claimed.
 *
 * Every step is checkpointed by the ADD-30 job runner, so a read survives Stop,
 * app quit and crashes, and resumes from its cursor.
 *
 * =============================================================================
 * DEPENDENCIES REUSED, NOT RE-PORTED
 * =============================================================================
 *   - `RecMeta`/`RecChapter`/`RecHighlight`/`RecNote`/`ReadStamp`/`By`/
 *     `NoteKind` + `segmentVisibleText`/`formatStamp`/`displaySpeaker`/
 *     `readStampOf`/`transcriptText` — `./recFormat.js`.
 *   - `parseRecMeta` (Rust's `parse_meta`) — `./recBridge.js`.
 *   - `Job`/`createJob`/`checkpointJob`/`setJobStatus`/`listJobs`/
 *     `getJobArtifact`/`putJobArtifact` — `./db-host/jobs.js`.
 *   - `getRecMeta`/`setRecMeta` — `./db-host/recordings.js`; `getFileName`/
 *     `setFileExtractedText` — `./db-host/files.js`.
 *   - `Lane`/`Step`/`StepResult`/`RunOutcome`/`CancelSignal`/`ProgressSink`/
 *     `RoomSource`/`JobRunnerDeps`/`runPlan`/`densePrefix`/`pinnedDb`/
 *     `emitProgress`/`spawnJobRunner` — `./jobs.js` (what Rust's `use super::*`
 *     pulls in from `commands/jobs.rs`).
 *   - `atCapacity`/`tryReserve`/`QUEUE_FULL`/`UNREADABLE_PLAN`/`JobQueueDeps`/
 *     `RowStarter`/`runnerDepsFrom` — `./jobQueue.js` (Rust's `super::queue`).
 *   - `resolvedBaseUrl` — `./engineRouting.js`. This IS the port of
 *     `ollama::resolved_base_url()`, so the map body's `base_url` is the room's
 *     really-configured Ollama URL rather than a hardcoded default.
 *   - `ensureUp`/`busy`/`authedHeaders` — `./sidecar.js`.
 *   - `CancelFlag`/`CancelState` — `./cancel.js`; `obs.warn`/`id`/`count` —
 *     `./obs.js`.
 *
 * =============================================================================
 * WHAT HAS NO PORT YET, AND WHAT THIS FILE DOES INSTEAD
 * =============================================================================
 *
 * - `resolve_pass_engine` (`commands/jobs.rs:1247`) reaches `ollama::list_models`,
 *   `runs_on_this_mac`, `capabilities` and a `model_setting` DB read — the same
 *   "engines/models" gap `jobs.ts`'s module doc excludes for `spawn_file_pass`.
 *   Injected as {@link ResolveReadEngine}, defaulting to
 *   {@link resolveReadEngineNotImplemented}: a labeled failure, never a
 *   fabricated model choice that would send a room's meeting transcript to
 *   whatever happens to be first in a hardcoded list. Same "stub, don't fake"
 *   convention as `jobs.ts`'s `renderPodcastAudioNotImplemented`.
 *
 * - `crate::sidecar::sidecar_json_cancellable` has no port in `sidecar.ts`
 *   (which ports only the STREAMING `/run` client). {@link sidecarJsonCancellableAt}
 *   is a small purpose-built analogue following the same shape Rust uses
 *   (`tokio::select!` between the POST and a 100 ms cancel poll): it races the
 *   `fetch` against a cancel poll and, on a Stop, calls `AbortController.abort()`
 *   — the TS equivalent of Rust dropping the in-flight future, which is what
 *   actually severs the connection so the sidecar's `until_hangup` fires.
 *   {@link sidecarErrorSentinel} is a faithful port of `SidecarError::sentinel`,
 *   `humanize_empty_generation` included, and the connect-vs-other split matches
 *   `sidecar_json_timeout`'s own `e.is_connect()` branch, so a mid-body network
 *   failure stays a NON-fatal skipped window and a refused connection parks the
 *   job for Resume.
 *
 * - PRIV-1's policy injection (`commands::inject_policy` /
 *   `ensure_provider_catalog` / `inject_provider_runtime`) lives in
 *   `sidecar_json_timeout` on the Rust side and has no port in this migration
 *   yet. A body posted through this helper reaches the sidecar exactly as
 *   given, with no privacy-door seam attached — tracked as a real gap, not
 *   silently absent.
 *
 * - `edit_rec_meta`'s Electron port is `recBridge.ts`'s `routeEdit`, an
 *   UNEXPORTED function bound to a closed op union (rename_speaker/add_note/
 *   set_note/add_chapter/set_chapter/add_highlight/delete_item) with no
 *   "replace every room finding" op. So the publish step reproduces routeEdit's
 *   own OFFLINE-branch body — which is `edit_rec_meta`'s own offline body,
 *   `recording_cmds.rs:761-771`: parse → mutate → `transcriptText` →
 *   `setFileExtractedText` → `setRecMeta` — by calling the exact same exported
 *   primitives. The mutation itself ({@link installFindings}) is ported
 *   line-for-line. NOT reproduced: routeEdit's LIVE branch (POSTing
 *   `/rec/edit_meta` while the file is the currently-recording session). Rust's
 *   own module header says a read runs only "when a recording is stopped, in
 *   the background for recordings the room already had, and from the 'Read this
 *   recording' button" — never against a live session. A future batch that
 *   needs that must add a sidecar op; this port does not invent one.
 *
 * - `ReadPlan`'s Rust struct carries no `#[serde(rename_all)]`, so a real Tauri
 *   room's `jobs.plan` column holds `file_id`/`file_name`/`visible_chars`. This
 *   port is camelCase, the SAME deviation `jobs.ts` already discloses for
 *   `Step.dependsOn`, for the same reason. Whoever wires cross-version job-row
 *   migration owns an adapter at that one seam.
 */

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
const KEEP_ALIVE_WARM = "30m";

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

function norm(s: string): string {
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
function readNoteKind(s: string): NoteKind | null {
  switch (s.trim().toLowerCase()) {
    case "decision":
      return "decision";
    case "action":
    case "action_item":
    case "task":
      return "action";
    case "question":
    case "open_question":
      return "question";
    case "point":
    case "key_point":
    case "summary":
      return "point";
    default:
      return null;
  }
}

/** Rust's `title.chars().take(n).collect()` — Unicode CODE POINTS, not UTF-16
 * code units, so an emoji at the boundary is never split into half a surrogate
 * pair. */
function takeChars(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

// =============================================================================
// mergeFindings — THE reduce, and the timestamp guarantee (rec_read.rs:223-332)
// =============================================================================

const BY_ROOM: By = "room";

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
  /** The ONE place a model's number becomes a time. A plain bounds-checked
   * index — no clamp, no nearest-match, no default. */
  const at = (n: number): number | undefined => turns[n]?.t0;

  // ---- chapters ----------------------------------------------------------
  const rawChapters: RecChapter[] = [];
  for (const a of found) {
    for (const c of a.chapters.slice(0, MAX_PER_WINDOW)) {
      const t0 = at(c.turn);
      const title = c.title.trim();
      if (t0 === undefined || title === "") {
        continue;
      }
      rawChapters.push({ id: randomUUID(), t0, title: takeChars(title, 80), by: BY_ROOM });
    }
  }
  rawChapters.sort((x, y) => x.t0 - y.t0);
  const chapters: RecChapter[] = [];
  for (const c of rawChapters) {
    const prev = chapters[chapters.length - 1];
    const crowded = prev !== undefined && c.t0 - prev.t0 < MIN_CHAPTER_GAP_CS;
    const repeat = chapters.some((p) => norm(p.title) === norm(c.title));
    if (!crowded && !repeat) {
      chapters.push(c);
    }
  }

  // ---- highlights --------------------------------------------------------
  const spans: Array<[number, number]> = [];
  for (const a of found) {
    for (const h of a.highlights.slice(0, MAX_PER_WINDOW)) {
      const t0 = at(h.turn);
      if (t0 === undefined) {
        continue;
      }
      // `until` before `turn` means the span is the turn itself; an `until`
      // past the transcript falls back to this turn's own end rather than
      // stretching the mark to a moment nobody spoke at.
      const t1 = Math.max(turns[Math.max(h.until, h.turn)]?.t1 ?? t0, t0);
      spans.push([t0, t1]);
    }
  }
  spans.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const highlights: RecHighlight[] = [];
  for (const [t0, t1] of spans) {
    const prev = highlights[highlights.length - 1];
    if (prev !== undefined && t0 <= prev.t1) {
      prev.t1 = Math.max(prev.t1, t1);
    } else {
      highlights.push({ id: randomUUID(), t0, t1, by: BY_ROOM });
    }
  }

  // ---- notes -------------------------------------------------------------
  const notes: RecNote[] = [];
  for (const a of found) {
    // Reset per WINDOW, and keyed by the model's own RAW (lowercased) `kind`
    // string rather than the canonical `NoteKind` — a faithful port of Rust's
    // `per_kind.entry(n.kind.to_lowercase())`. So "action" and "action_item"
    // each get their own budget inside one window even though both normalize to
    // `action`. Preserved as written, not "fixed".
    const perKind = new Map<string, number>();
    for (const n of a.notes) {
      const t0 = at(n.turn);
      const kind = readNoteKind(n.kind);
      if (t0 === undefined || kind === null) {
        continue;
      }
      const text = n.text.trim();
      if (text === "") {
        continue;
      }
      const rawKey = n.kind.toLowerCase();
      const seen = perKind.get(rawKey) ?? 0;
      if (seen >= MAX_PER_WINDOW) {
        continue;
      }
      perKind.set(rawKey, seen + 1);
      if (notes.some((p) => p.kind === kind && norm(p.text) === norm(text))) {
        continue;
      }
      // Only somebody who actually speaks here.
      const who = n.who === null ? "" : n.who.trim();
      notes.push({
        id: randomUUID(),
        t0,
        kind,
        text: takeChars(text, 400),
        who: who !== "" && speakers.has(who) ? who : null,
        by: BY_ROOM,
      });
    }
  }
  notes.sort((x, y) => x.t0 - y.t0);

  return { chapters, highlights, notes };
}

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

function asRecord(v: unknown): Record<string, unknown> | null {
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
function turnNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function coerceFoundChapter(v: unknown): FoundChapter | null {
  const o = asRecord(v);
  if (o === null) {
    return null;
  }
  const turn = turnNumber(o.turn);
  return turn === null ? null : { turn, title: stringOr(o.title, "") };
}

function coerceFoundHighlight(v: unknown): FoundHighlight | null {
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

function coerceFoundNote(v: unknown): FoundNote | null {
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

function coerceList<T>(v: unknown, one: (x: unknown) => T | null): T[] {
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

/** Shape-check a stored `jobs.plan` value into a {@link ReadPlan}, throwing on
 * any structural violation — the caller turns that into {@link UNREADABLE_PLAN},
 * mirroring `serde_json::from_value::<ReadPlan>(..).map_err(|_| "This job's
 * plan is unreadable.")`. */
export function parseReadPlan(value: unknown): ReadPlan {
  const o = asRecord(value);
  const stamp = o === null ? null : asRecord(o.stamp);
  if (
    o === null ||
    typeof o.fileId !== "string" ||
    typeof o.fileName !== "string" ||
    stamp === null ||
    typeof stamp.turns !== "number" ||
    typeof stamp.chars !== "number" ||
    !Array.isArray(o.windows)
  ) {
    throw new Error(UNREADABLE_PLAN);
  }
  const windows: Array<[number, number]> = [];
  for (const w of o.windows) {
    if (!Array.isArray(w) || w.length !== 2 || typeof w[0] !== "number" || typeof w[1] !== "number") {
      throw new Error(UNREADABLE_PLAN);
    }
    windows.push([w[0], w[1]]);
  }
  return {
    fileId: o.fileId,
    fileName: o.fileName,
    stamp: { turns: stamp.turns, chars: stamp.chars },
    windows,
    visibleChars: typeof o.visibleChars === "number" ? o.visibleChars : null,
  };
}

function stampsEqual(a: ReadStamp, b: ReadStamp): boolean {
  return a.turns === b.turns && a.chars === b.chars;
}

// =============================================================================
// the cancellable sidecar JSON POST — see the module header
// =============================================================================

/** A classified failure from a sidecar feature endpoint: the `{code,error}`
 * envelope every non-2xx response carries, plus the HTTP status. Rust's
 * `SidecarError`. */
export interface SidecarJsonError {
  code: string;
  error: string;
  status: number;
}

/** What one `/rec_read_map` call produced — Rust's collapsed
 * `Result<Option<Value>, SidecarError>`. */
export type SidecarJsonOutcome =
  | { kind: "value"; value: unknown }
  | { kind: "cancelled" }
  | { kind: "error"; error: SidecarJsonError };

export type RecReadSidecarCall = (
  path: string,
  body: Record<string, unknown>,
  cancel: CancelSignal
) => Promise<SidecarJsonOutcome>;

const SIDECAR_DOWN_CODE = "SIDECAR_DOWN";

/** The phrases that actually mean "the provider refused this because of your
 * allowance" — `sidecar.rs`'s `EMPTY_GENERATION_HINTS`, verbatim. */
const EMPTY_GENERATION_HINTS: readonly string[] = [
  "usage limit",
  "reached your",
  "no generation chunks",
  "quota exceeded",
  "quota exhausted",
  "out of quota",
  "insufficient_quota",
  "insufficient quota",
];

/** Port of `sidecar::humanize_empty_generation`. */
function humanizeEmptyGeneration(msg: string): string | null {
  const lower = msg.toLowerCase();
  return EMPTY_GENERATION_HINTS.some((hint) => lower.includes(hint))
    ? "The AI model returned nothing. If this room uses a cloud model, it may " +
        "have hit its usage limit — switch to an on-device model in Settings → " +
        "Model, or try again later."
    : null;
}

/** Port of `SidecarError::sentinel` (`sidecar.rs:73-94`). `SIDECAR_DOWN`
 * deliberately does NOT collapse into `OLLAMA_DOWN`: that token is the
 * frontend's trigger for an "Open Ollama" button, and offering it to a
 * cloud-model room whose AI HELPER failed to start is the exact confusion the
 * split exists to end. */
export function sidecarErrorSentinel(e: SidecarJsonError, model: string | null): string {
  switch (e.code) {
    case "OLLAMA_DOWN":
      return "OLLAMA_DOWN";
    case SIDECAR_DOWN_CODE:
      return `Arcelle's AI helper could not start, so nothing could run: ${e.error}`;
    case "MODEL_MISSING":
      return model !== null ? `MODEL_MISSING:${model}` : "MODEL_MISSING";
    default:
      return humanizeEmptyGeneration(e.error) ?? `Local AI error (${e.status}): ${e.error}`;
  }
}

/** The same 100 ms cadence `sidecar_json_cancellable`'s `tokio::select!` polls
 * the flag at. */
const CANCEL_POLL_MS = 100;

/** Walk an error's `.cause` chain looking for a POSIX `ECONNREFUSED` — the same
 * check `sidecar.ts`'s own (non-exported) `isConnectionRefused` makes for the
 * `/run` client, duplicated locally rather than exporting a private helper out
 * of a file this port must not touch. This is the TS stand-in for reqwest's
 * `e.is_connect()`, and the distinction is load-bearing: a refused connection
 * is `OLLAMA_DOWN` (fatal — the job parks for Resume), while a socket that dies
 * mid-body is a plain engine error (non-fatal — this one window is marked
 * skipped and the read carries on), exactly as `sidecar_json_timeout` splits
 * them. */
function isConnectFailure(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur != null; i++) {
    if ((cur as { code?: unknown }).code === "ECONNREFUSED") {
      return true;
    }
    // A host that resolves to several addresses (`localhost` → ::1 AND
    // 127.0.0.1) fails as an `AggregateError` whose own `.code` is undefined
    // and whose per-address `ECONNREFUSED`s hang off `.errors`. Without this
    // the SAME dead sidecar would be classified fatal on one machine and
    // survivable on another, purely by how its base URL is spelled.
    const nested: unknown = (cur as { errors?: unknown }).errors;
    if (
      Array.isArray(nested) &&
      nested.some((e) => (e as { code?: unknown }).code === "ECONNREFUSED")
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * POST a JSON body to a sidecar FEATURE endpoint at an EXPLICIT base, racing it
 * against a caller-owned cancel flag — split out from
 * {@link sidecarJsonCancellable} so the wire behaviour is testable against a
 * real `http.Server` with no sidecar process involved, matching this repo's
 * `xxxAt(base, …)` convention (`sidecar.ts`'s `streamRun`, `engineRouting.ts`'s
 * `listModelsAt`).
 *
 * Like Rust's `sidecar_json_cancellable`, an ALREADY-set flag short-circuits
 * before any network call. Unlike Rust — which drops the in-flight `Future` and
 * relies on the sidecar's `until_hangup` to notice the severed connection —
 * this aborts the `fetch` through an `AbortController`, which has the same
 * effect without depending on a JS engine ever dropping an unawaited promise's
 * underlying request.
 *
 * The poll is one `setInterval`, cleared in a `finally`: a response that
 * arrives in 3 ms returns in 3 ms, and nothing is left holding a timer open.
 *
 * Never throws: every failure — a non-2xx status, a malformed body, a network
 * error — comes back as a value.
 */
export async function sidecarJsonCancellableAt(
  base: string,
  path: string,
  body: Record<string, unknown>,
  cancel: CancelSignal
): Promise<SidecarJsonOutcome> {
  if (cancel.load()) {
    return { kind: "cancelled" };
  }
  const controller = new AbortController();
  let poll: ReturnType<typeof setInterval> | undefined;
  const cancelled = new Promise<"cancelled">((resolve) => {
    poll = setInterval(() => {
      if (cancel.load()) {
        controller.abort();
        resolve("cancelled");
      }
    }, CANCEL_POLL_MS);
  });

  // Deliberately value-carrying rather than throwing, so the race below has
  // exactly two outcomes and a losing request can never surface as an
  // unhandled rejection.
  const request: Promise<SidecarJsonOutcome> = (async () => {
    let resp: Response;
    try {
      resp = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { ...authedHeaders(), "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (cancel.load()) {
        return { kind: "cancelled" };
      }
      return {
        kind: "error",
        error: {
          code: isConnectFailure(err) ? "OLLAMA_DOWN" : "ENGINE_ERROR",
          error: err instanceof Error ? err.message : String(err),
          status: 0,
        },
      };
    }
    let json: unknown = null;
    try {
      json = await resp.json();
    } catch {
      json = null;
    }
    if (resp.ok) {
      return { kind: "value", value: json };
    }
    const obj = asRecord(json) ?? {};
    return {
      kind: "error",
      error: {
        code: typeof obj.code === "string" ? obj.code : "ENGINE_ERROR",
        error: typeof obj.error === "string" ? obj.error : "unknown error",
        status: resp.status,
      },
    };
  })();

  try {
    const winner = await Promise.race([request, cancelled]);
    return winner === "cancelled" ? { kind: "cancelled" } : winner;
  } finally {
    clearInterval(poll);
  }
}

/**
 * Ensure the sidecar is up, hold a {@link busy} guard for the POST, and drive
 * {@link sidecarJsonCancellableAt} against it — the production call
 * {@link executeReadStep} makes. The guard is taken AFTER `ensureUp` and
 * released in a `finally`, exactly where `sidecar_json_timeout` places its own
 * `let _busy = sidecar_lifecycle::busy();`, so a health probe on another task
 * cannot replace the sidecar that is answering this window.
 */
export async function sidecarJsonCancellable(
  path: string,
  body: Record<string, unknown>,
  cancel: CancelSignal
): Promise<SidecarJsonOutcome> {
  if (cancel.load()) {
    return { kind: "cancelled" };
  }
  let base: string;
  try {
    base = await ensureUp();
  } catch (err) {
    return {
      kind: "error",
      error: {
        code: SIDECAR_DOWN_CODE,
        error: err instanceof Error ? err.message : String(err),
        status: 503,
      },
    };
  }
  const guard = busy();
  try {
    return await sidecarJsonCancellableAt(base, path, body, cancel);
  } finally {
    guard.release();
  }
}

// =============================================================================
// injected seams
// =============================================================================

/** Where the "some windows could not be read" warning goes. Injectable and
 * defaulting to the real host log, the same convention `db-host/jobs.ts` uses
 * for its own `JobStatusLog`. */
export interface RecReadLog {
  warn: typeof obs.warn;
}

const REAL_LOG: RecReadLog = obs;

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

function loadArtifact(db: Database.Database, jobId: string, stepId: number): ReadArtifact | null {
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

function storeArtifact(
  db: Database.Database,
  jobId: string,
  stepId: number,
  a: ReadArtifact
): void {
  putJobArtifact(db, jobId, stepId, JSON.stringify(a));
}

// =============================================================================
// executeReadStep — map / publish (rec_read.rs:407-545)
// =============================================================================

const ROOM_GONE = "The room this job belongs to is no longer open.";
const RECORDING_GONE = "That recording is no longer in the room.";
const TRANSCRIPT_CHANGED_MID_READ =
  "That recording's transcript changed while it was being read — read it again.";

async function executeMapStep(
  deps: RecReadStepDeps,
  jobId: string,
  roomPath: string,
  plan: ReadPlan,
  model: string,
  turns: readonly Turn[],
  step: Step,
  cancel: CancelSignal
): Promise<StepResult> {
  const n = plan.windows.length;
  // Rust's `step.params["window"].as_u64().unwrap_or(0)`: `as_u64` is `None`
  // for a missing, negative or fractional value, and 0 is the fallback.
  const i = turnNumber(asRecord(step.params)?.window) ?? 0;
  const range = plan.windows[i];
  if (range === undefined) {
    return { ok: false, error: `window ${i} is not in the plan` };
  }

  let thread = "";
  if (i > 0) {
    const db = pinnedDb(deps.rooms, roomPath);
    if (db === null) {
      return { ok: false, error: ROOM_GONE };
    }
    thread = loadArtifact(db, jobId, i - 1)?.thread ?? "";
  }

  // `model` in the body is load-bearing beyond choosing an engine: the sidecar
  // gateway injects the room's privacy policy on any non-local model
  // (`commands::inject_policy`), so a cloud engine never sees raw meeting
  // transcripts. Prompts, schema, retries and clamps live in the sidecar,
  // exactly as `/file_pass_map` does it. See the module header for what that
  // injection step's absence means on this side of the migration.
  const body: Record<string, unknown> = {
    model,
    base_url: resolvedBaseUrl(),
    file_name: plan.fileName,
    part: i,
    total: n,
    thread,
    turns: windowText(turns, range),
    keep_alive: KEEP_ALIVE_WARM,
  };

  const call = deps.sidecarCall ?? sidecarJsonCancellable;
  const outcome = await call("/rec_read_map", body, cancel);

  let artifact: ReadArtifact;
  if (outcome.kind === "cancelled") {
    return { ok: false, error: "STOPPED" };
  } else if (outcome.kind === "value") {
    artifact = coerceReadArtifact(outcome.value);
  } else {
    const msg = sidecarErrorSentinel(outcome.error, model);
    if (isFatal(msg)) {
      return { ok: false, error: msg };
    }
    // One window lost is not a lost read — record it as skipped so the count
    // stays honest and carry on.
    artifact = { ...defaultReadArtifact(), thread, skipped: true };
  }

  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) {
    return { ok: false, error: ROOM_GONE };
  }
  storeArtifact(db, jobId, i, artifact);
  return { ok: true };
}

/** Synchronous by construction: nothing here awaits, so the meta this step
 * reads cannot be replaced between the read and the write it derives. */
function executePublishStep(
  deps: RecReadStepDeps,
  jobId: string,
  roomPath: string,
  plan: ReadPlan
): StepResult {
  const n = plan.windows.length;
  const readDb = pinnedDb(deps.rooms, roomPath);
  if (readDb === null) {
    return { ok: false, error: ROOM_GONE };
  }
  const found: ReadArtifact[] = [];
  for (let i = 0; i < n; i++) {
    const a = loadArtifact(readDb, jobId, i);
    if (a !== null) {
      found.push(a);
    }
  }
  const skipped = found.filter((a) => a.skipped).length;

  const metaDb = pinnedDb(deps.rooms, roomPath);
  if (metaDb === null) {
    return { ok: false, error: ROOM_GONE };
  }
  const metaJson = getRecMeta(metaDb, plan.fileId);
  if (metaJson === null) {
    return { ok: false, error: RECORDING_GONE };
  }
  let meta: RecMeta;
  try {
    meta = parseRecMeta(metaJson);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const turnsNow = turnsOf(meta);
  // Everyone who actually speaks here — the only names an action item may be
  // attributed to.
  const speakers = new Set(turnsNow.map((t) => t.who));
  const stamp = readStampOf(meta.segments);

  // The words moved under us (a re-transcribe, a correction, a phrase deleted)
  // — the findings are about a transcript that no longer exists, so writing
  // them would put marks on the wrong moments.
  if (!stampsEqual(stamp, plan.stamp) || turnsMoved(plan, turnsNow)) {
    return { ok: false, error: TRANSCRIPT_CHANGED_MID_READ };
  }
  if (n > 0 && skipped === n) {
    // Not "the room read it and found nothing": the room read NONE of it.
    // Stamping `readOf` here would also retire the file from the background
    // sweep, so nothing would ever look at it again.
    return {
      ok: false,
      error:
        `No part of "${plan.fileName}" could be read — the model answered for ` +
        `none of the ${n} parts. Read it again.`,
    };
  }

  const { chapters, highlights, notes } = mergeFindings(found, turnsNow, speakers);

  const writeDb = pinnedDb(deps.rooms, roomPath);
  if (writeDb === null) {
    return { ok: false, error: ROOM_GONE };
  }
  // Idempotent by construction: `installFindings` REPLACES the room's items
  // every time, so a replay after a crash cannot double them. The three lines
  // below are `edit_rec_meta`'s own offline body — see the module header for
  // why `routeEdit` cannot be called directly.
  installFindings(meta, chapters, highlights, notes, stamp);
  setFileExtractedText(writeDb, plan.fileId, transcriptText(meta));
  setRecMeta(writeDb, plan.fileId, JSON.stringify(meta));

  if (skipped > 0) {
    // Never silent. A read that could not reach part of the meeting must not
    // present itself as having read all of it.
    (deps.log ?? REAL_LOG).warn("rec_read_incomplete", [
      ["file", obs.id(plan.fileName)],
      ["skipped", obs.count(skipped)],
      ["parts", obs.count(n)],
    ]);
  }
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

// =============================================================================
// spawnRecRead (rec_read.rs:672-805)
// =============================================================================

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
    const startingDb = pinnedDb(deps.rooms, roomPath);
    if (startingDb !== null) {
      setJobStatus(startingDb, jobId, "running", null);
    }
    const total = steps.length;
    emitProgress(deps.sink, jobId, readProgressLabel(plan, startCursor), startCursor, total);

    const startDone = new Set<number>();
    for (let i = 0; i < startCursor; i++) {
      startDone.add(i);
    }
    // How far the read actually got, for the terminal tick below — a paused or
    // failed card must not lose a bar that had honestly advanced.
    let lastCursor = startCursor;

    const raw = await runPlan(
      steps,
      startDone,
      cancel,
      (step) => executeReadStep(deps, jobId, roomPath, plan, chatModel, turns, step, cancel),
      (doneSet) => {
        const cursor = densePrefix(doneSet);
        lastCursor = cursor;
        const db = pinnedDb(deps.rooms, roomPath);
        if (db !== null) {
          checkpointJob(db, jobId, cursor, {});
        }
      },
      (done, totalNow) => {
        emitProgress(deps.sink, jobId, readProgressLabel(plan, done), done, totalNow);
      }
    );
    const outcome: RunOutcome = raw.kind === "error" && cancel.load() ? { kind: "paused" } : raw;

    const finishingDb = pinnedDb(deps.rooms, roomPath);
    if (finishingDb !== null) {
      const status =
        outcome.kind === "done" ? "done" : outcome.kind === "paused" ? "paused" : "error";
      setJobStatus(finishingDb, jobId, status, outcome.kind === "error" ? outcome.error : null);
    }
    deps.removeCancelFlag(jobId);

    try {
      deps.onReadDone?.(
        outcome.kind === "done"
          ? { fileId: plan.fileId, ok: true }
          : outcome.kind === "paused"
            ? { fileId: plan.fileId, ok: false }
            : { fileId: plan.fileId, ok: false, error: outcome.error }
      );
    } catch {
      // Best-effort, matching Rust's `let _ = window.emit(..)`.
    }

    // …and the terminal job tick every other runner emits, so the sidebar's
    // live card clears and a failure reaches the standard toast instead of
    // resting on a job row nobody is looking at. No `fileId`: the file is
    // already open in the view that asked for the read, and a background sweep
    // must not pull the room away from what the reader is doing.
    deps.sink.emit(
      outcome.kind === "done"
        ? { jobId, label: `Finished reading "${plan.fileName}"`, done: total, total, finished: true }
        : outcome.kind === "paused"
          ? { jobId, label: "Paused", done: lastCursor, total, paused: true }
          : { jobId, label: `Stopped — ${outcome.error}`, done: lastCursor, total, failed: true }
    );

    await deps.onSettled(jobId);
  });
}

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

function recReadRunnerDeps(deps: JobQueueDeps, extra: RecReadExtraDeps): RecReadRunnerDeps {
  return {
    ...runnerDepsFrom(deps),
    sidecarCall: extra.sidecarCall,
    log: extra.log,
    onReadDone: extra.onReadDone,
  };
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
  const room = deps.rooms.current();
  if (room === null) {
    throw new Error("No room is open.");
  }
  const roomPath = room.path;

  const fileName = getFileName(room.db, fileId);
  const metaJson = getRecMeta(room.db, fileId);
  if (metaJson === null) {
    throw new Error("That file is not a recording.");
  }
  const meta = parseRecMeta(metaJson);
  const stamp = readStampOf(meta.segments);
  const turns = turnsOf(meta);

  if (turns.length === 0) {
    throw new Error("That recording has no transcript to read yet.");
  }
  if (readingNow(room.db, fileId)) {
    throw new Error("That recording is already being read.");
  }

  const windows = partitionTurns(turns, READ_WINDOW_CHARS);
  const { chatModel, lane } = await (extra.resolvePassEngine ?? resolveReadEngineNotImplemented)();
  const steps = buildReadSteps(windows.length, lane);
  const plan: ReadPlan = {
    fileId,
    fileName,
    stamp,
    windows,
    visibleChars: visibleChars(turns),
  };

  // Re-pin after the `await` above: resolving an engine can take seconds, and
  // the job row must be created in the SAME room the runner is pinned to —
  // otherwise a room swapped mid-resolve would get a row for work whose every
  // write goes somewhere else.
  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) {
    throw new Error(ROOM_GONE);
  }
  if (atCapacity(db)) {
    throw new Error(QUEUE_FULL);
  }
  const jobId = createJob(db, "rec_read", `Reading ${fileName}`, plan, steps.length);

  // Reserve or wait: a busy room leaves the row QUEUED and the pump starts it
  // when a lane frees up (through {@link recReadRowStarter}). That is what
  // keeps an automatic read of every old recording from competing with the work
  // the user is actually doing.
  if (tryReserve(deps.state, jobId)) {
    const cancel = new CancelFlag();
    deps.cancelState.jobCancels.set(jobId, cancel);
    void spawnRecRead(
      recReadRunnerDeps(deps, extra),
      jobId,
      roomPath,
      plan,
      chatModel,
      steps,
      0,
      cancel,
      turns
    );
  }
  return jobId;
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
  return async (deps, job, roomPath, cancel): Promise<RowStartResult> => {
    let plan: ReadPlan;
    try {
      plan = parseReadPlan(job.plan);
    } catch {
      return { kind: "error", message: UNREADABLE_PLAN };
    }

    const db = pinnedDb(deps.rooms, roomPath);
    if (db === null) {
      return { kind: "error", message: ROOM_GONE };
    }
    const metaJson = getRecMeta(db, plan.fileId);
    if (metaJson === null) {
      return {
        kind: "error",
        message: "The recording this read belongs to is no longer in the room.",
      };
    }
    let meta: RecMeta;
    try {
      meta = parseRecMeta(metaJson);
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
    // Same guard as `file_pass`: a plan is only valid against the words it was
    // built from. Findings written against a transcript that has since been
    // re-transcribed would land on the wrong moments.
    const turns = turnsOf(meta);
    if (!stampsEqual(readStampOf(meta.segments), plan.stamp) || turnsMoved(plan, turns)) {
      return { kind: "error", message: "That recording's transcript changed — read it again." };
    }

    let chatModel: string;
    let lane: Lane;
    try {
      ({ chatModel, lane } = await (extra.resolvePassEngine ?? resolveReadEngineNotImplemented)());
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
    const steps = buildReadSteps(plan.windows.length, lane);
    const cursor = Math.min(Math.max(Math.trunc(job.cursor), 0), steps.length);
    void spawnRecRead(
      recReadRunnerDeps(deps, extra),
      job.id,
      roomPath,
      plan,
      chatModel,
      steps,
      cursor,
      cancel,
      turns
    );
    return { kind: "runner" };
  };
}
