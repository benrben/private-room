/**
 * Wave 4a: the job QUEUE. The one-job guard (three `job_cancels.is_empty()`
 * checks) becomes a serialized FIFO queue so a second heavy job (a scheduled
 * run colliding with a manual summarize) waits instead of erroring — no
 * parallelism (one resident local model makes concurrent heavy work strictly
 * slower), just no collision. The DB `status='queued'` IS the queue (FIFO by
 * `created_at` via `unfinishedJobs`); {@link JobQueueState.runningJob} is the
 * single slot.
 *
 * Ported from `src-tauri/src/commands/jobs/queue.rs` (531 lines, read in full,
 * including its `#[cfg(test)] mod tests`).
 *
 * {@link startJobFromRow} is the ONE dispatcher {@link submit}, {@link pump}
 * and (in Rust) `resume_job` share: given a job row it rebuilds the job's plan
 * and starts its runner. A start failure marks that row 'error' and pumps the
 * next row, so a poisoned head can never head-of-line-block the whole queue.
 *
 * SCOPE — why the per-kind dispatch is a REGISTRY rather than a hard-wired
 * `switch`. Rust's `start_job_from_row` matches `job.kind` against eight
 * spawners (`start_deep_summary_row`/`start_file_pass_row`/`start_workflow_row`/
 * `start_studio_row`/`start_podcast_audio_row`/`start_download_row`/
 * `start_create_row`/`start_rec_read_row`), every one of which reaches into a
 * subsystem this rewrite has not ported (`AppState`, `ollama`, `extraction`,
 * and the `file_pass`/`workflow`/`download`/`create`/`rec_read`/`auto_index`
 * sub-modules — see `jobs.ts`'s module doc). So the dispatch is an injected
 * {@link RowStarter} registry rather than a `switch` with one working arm; a
 * future batch registers its own kind without touching this file. The one kind
 * this batch CAN start for real (down to its own injected TTS seam) is
 * `podcast_audio`, via {@link podcastAudioRowStarter}.
 *
 * A kind that is KNOWN but not yet wired answers {@link notImplementedRowStarter}'s
 * labeled `NOT_IMPLEMENTED: …`, which flows through EXACTLY the "poisoned row"
 * path Rust already has for a start that fails: the row is marked 'error' (the
 * Sidebar shows Retry), the slot is freed, and the pump moves on. A kind
 * {@link KNOWN_JOB_KINDS} has never heard of gets the Rust source's own literal
 * "This job kind can't be started." — so "not ported yet" and "not a real job
 * kind at all" stay two different sentences, which on the Rust side they
 * trivially are (every arm there is real).
 *
 * DEVIATION — `AppState`/`tauri::Window` → {@link JobQueueDeps}: no host
 * room-state module exists in this rewrite yet (`roomPin.ts` carries the
 * identical note), so this file is declared against the same minimal seams
 * `jobs.ts` defines ({@link RoomSource}, {@link ProgressSink}) plus its own
 * {@link JobQueueState} for `AppState.running_job`. The cancel registry is
 * `cancel.ts`'s own `CancelState.jobCancels` — deliberately NOT a second,
 * parallel map: `cancel.ts`'s `cancelId` already knows to look there, so a
 * future `cancel_job` wired against it finds exactly the flag this queue
 * registered, with nothing to keep in sync.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag, type CancelState } from "./cancel.js";
import { getJob, type Job, setJobStatus, unfinishedJobs } from "./db-host/jobs.js";
import {
  type JobRunnerDeps,
  type ProgressSink,
  type RenderPodcastAudio,
  type RoomSource,
  spawnPodcastAudio,
} from "./jobs.js";

/** Cap on queued rows so a runaway scheduler can't pile up unbounded work. */
export const MAX_QUEUED = 10;

/** The ONE sentence every "the queue is full" refusal uses. It is one situation
 * — deep summary, studio, file pass, download and workflow all hit the same cap
 * — so it must not read like three different problems. */
export const QUEUE_FULL = "Too many background jobs are already waiting — let some finish first.";

/** `AppState.running_job`'s stand-in: `null` = free; a job id = that job holds
 * the one heavy-work slot. A fresh process starts empty. */
export interface JobQueueState {
  runningJob: string | null;
}

export function createJobQueueState(): JobQueueState {
  return { runningJob: null };
}

/** How many jobs are waiting in the queue right now (for the "cap" error). An
 * unreadable jobs table THROWS, never a confident zero — mirroring the Rust
 * `Result<usize, String>`. */
export function queuedCount(db: Database.Database): number {
  return unfinishedJobs(db).filter((j) => j.status === "queued").length;
}

/** True when the queue is at capacity — a new job should be refused. A queue
 * that cannot be READ counts as full: guessing "there's room" would let the cap
 * silently stop protecting the room the moment the DB is unhappy. */
export function atCapacity(db: Database.Database): boolean {
  try {
    return queuedCount(db) >= MAX_QUEUED;
  } catch {
    return true;
  }
}

/** Reserve the running slot iff free (compare-and-swap `null` → `jobId`). */
export function tryReserve(state: JobQueueState, jobId: string): boolean {
  if (state.runningJob !== null) {
    return false;
  }
  state.runningJob = jobId;
  return true;
}

/** Free the running slot iff this job holds it. */
function freeSlot(state: JobQueueState, jobId: string): void {
  if (state.runningJob === jobId) {
    state.runningJob = null;
  }
}

/**
 * True when the single heavy-work slot is available to the OPEN room. A slot
 * still held by a job of a room that has since been closed or swapped would
 * otherwise block the new room's queue for as long as the cancelled job takes
 * to notice — minutes, inside a slow model call. A job id the current room has
 * never heard of cannot be running against it, so that claim is released here.
 */
function slotFreeForThisRoom(state: JobQueueState, rooms: RoomSource): boolean {
  const holder = state.runningJob;
  if (holder === null) {
    return true;
  }
  const room = rooms.current();
  if (room === null) {
    return false; // no room open — there is nothing to pump anyway.
  }
  try {
    getJob(room.db, holder);
    return false; // the open room owns the running job — genuinely busy.
  } catch {
    // The open room has no such job: the slot belongs to a room that is gone.
    // Its own epilogue's `finishAndPump` becomes a no-op, which is exactly
    // right — its writes were already room-pinned.
    freeSlot(state, holder);
    return true;
  }
}

// ============================================================================
// The per-kind dispatch seam
// ============================================================================

/** How starting a job from its row ended — the TS analogue of Rust's
 * `Result<bool, String>` (which `start_job_from_row` then folds into its
 * `Started` enum). */
export type RowStartResult =
  /** A durable runner is driving; it holds the slot and its own epilogue (via
   * {@link finishAndPump}) frees it. */
  | { readonly kind: "runner" }
  /** Finished synchronously with no runner (e.g. an auto-index with nothing
   * left to do). The starter has ALREADY written the row's terminal status;
   * the caller frees the slot and pumps the next row. */
  | { readonly kind: "immediate" }
  /** Could not start; the row will be marked 'error' and the slot freed, so the
   * pump moves on to the next row. */
  | { readonly kind: "error"; readonly message: string };

/** Resolve one job row into running work. `deps` is passed through so a starter
 * can reach the room, the progress sink and {@link finishAndPump} — see
 * {@link podcastAudioRowStarter} for the shape a real one takes. A starter that
 * THROWS is treated exactly like `{kind:"error"}` carrying the thrown message,
 * so an unexpected failure poisons its own row instead of rejecting out of the
 * pump and stranding the slot forever. */
export type RowStarter = (
  deps: JobQueueDeps,
  job: Job,
  roomPath: string,
  cancel: CancelFlag
) => Promise<RowStartResult>;

/** The eight job kinds `queue.rs`'s `start_job_from_row` knows how to name.
 * Used only to pick the right refusal sentence for a kind with no
 * {@link RowStarter} registered — see this file's module doc. */
export const KNOWN_JOB_KINDS: ReadonlySet<string> = new Set([
  "deep_summary",
  "file_pass",
  "workflow",
  "studio",
  "podcast_audio",
  "download",
  "create",
  "rec_read",
]);

/** Rust's own fallback arm, verbatim — for a kind that is not a job kind at
 * all. */
export const UNKNOWN_JOB_KIND = "This job kind can't be started.";

/** Every job kind's sentence for an unreadable stored plan, verbatim from
 * `queue.rs` (`start_file_pass_row`, `start_studio_row`,
 * `start_podcast_audio_row`, `start_workflow_row` all use it). */
export const UNREADABLE_PLAN = "This job's plan is unreadable.";

/** A row-starter for a job kind this rewrite has not wired a real spawner for
 * yet — a labeled `NOT_IMPLEMENTED: …` result, never a thrown exception,
 * following `execTool.ts`'s `notImplemented` convention. */
export function notImplementedRowStarter(kind: string): RowStarter {
  return async () => ({
    kind: "error",
    message: `NOT_IMPLEMENTED: the "${kind}" job kind has no Electron row-starter yet.`,
  });
}

/** Read a string field off a stored plan blob, or `null` if it isn't one. */
function planString(plan: unknown, key: string): string | null {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
    return null;
  }
  const value = (plan as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/**
 * The real row-starter for `podcast_audio` — the one kind this batch can
 * actually start, down to its own injected TTS seam. Mirrors
 * `start_podcast_audio_row`: read `scriptFileId` off the immutable plan (an
 * unreadable plan is refused with the same sentence Rust uses), then
 * fire-and-forget the runner. `spawn_podcast_audio` is a synchronous
 * `tauri::async_runtime::spawn` that never awaits the job, and this mirrors
 * that by deliberately not awaiting {@link spawnPodcastAudio}: the row is a
 * "runner" the instant it is spawned, not once it finishes.
 *
 * Like a studio run, a podcast recording is a single atomic unit with no
 * cursor: a half-recorded episode is not a resumable state, it is a file nobody
 * wants, so resuming re-records from the top.
 */
export function podcastAudioRowStarter(render?: RenderPodcastAudio): RowStarter {
  return async (deps, job, roomPath, cancel) => {
    const scriptFileId = planString(job.plan, "scriptFileId");
    if (scriptFileId === null) {
      return { kind: "error", message: UNREADABLE_PLAN };
    }
    void spawnPodcastAudio(
      { ...runnerDepsFrom(deps), render },
      job.id,
      roomPath,
      scriptFileId,
      cancel
    );
    return { kind: "runner" };
  };
}

/** The {@link JobRunnerDeps} a runner started by THIS queue gets: the queue's
 * own room/sink, its cancel registry, and an `onSettled` that frees the slot
 * and pumps the next waiter. Built here rather than asked for separately so a
 * runner can never be wired to a different registry than the one that
 * registered its flag. */
export function runnerDepsFrom(deps: JobQueueDeps): JobRunnerDeps {
  return {
    rooms: deps.rooms,
    sink: deps.sink,
    removeCancelFlag: (jobId) => {
      deps.cancelState.jobCancels.delete(jobId);
    },
    onSettled: (jobId) => finishAndPump(deps, jobId),
  };
}

/** A starters registry with `podcast_audio` wired to a real (if TTS-stubbed)
 * spawner — the sensible default for a caller that has not built its own. */
export function defaultRowStarters(render?: RenderPodcastAudio): Map<string, RowStarter> {
  return new Map<string, RowStarter>([["podcast_audio", podcastAudioRowStarter(render)]]);
}

// ============================================================================
// The queue itself
// ============================================================================

/** Everything {@link submit}/{@link pump}/{@link startJobFromRow} need. */
export interface JobQueueDeps {
  /** The single heavy-work slot — `AppState.running_job`. */
  state: JobQueueState;
  rooms: RoomSource;
  sink: ProgressSink;
  /** `AppState.job_cancels`, reused via `cancel.ts`'s own `CancelState` — see
   * this file's module doc. */
  cancelState: CancelState;
  /** Row starters keyed by job kind. */
  starters: ReadonlyMap<string, RowStarter>;
}

/** What starting one row obliges the pump to do next — Rust's `Started`. */
type Started =
  /** A durable runner is driving; it holds the slot and its epilogue pumps. */
  | "runner"
  /** Finished synchronously, or poisoned and recorded as such — either way the
   * slot is free and the pump should try the next row. */
  | "continue"
  /** Could not start AND could not record that — re-picking this row would spin
   * the pump at full speed forever, so the pump must stop. */
  | "stuck";

/** The single dispatcher: read a job row, resolve its {@link RowStarter}, and
 * start it. Ported from `start_job_from_row`. */
async function startJobFromRow(deps: JobQueueDeps, jobId: string): Promise<Started> {
  const room = deps.rooms.current();
  if (room === null) {
    // The row itself is unreadable (there is no room to read it from), so it
    // cannot be marked 'error' either — re-picking it would loop, so stop.
    freeSlot(deps.state, jobId);
    return "stuck";
  }
  let job: Job;
  try {
    job = getJob(room.db, jobId);
  } catch {
    freeSlot(deps.state, jobId);
    return "stuck";
  }
  const roomPath = room.path;

  const cancel = new CancelFlag();
  deps.cancelState.jobCancels.set(jobId, cancel);

  const starter =
    deps.starters.get(job.kind) ??
    (KNOWN_JOB_KINDS.has(job.kind)
      ? notImplementedRowStarter(job.kind)
      : async (): Promise<RowStartResult> => ({ kind: "error", message: UNKNOWN_JOB_KIND }));

  let result: RowStartResult;
  try {
    result = await starter(deps, job, roomPath, cancel);
  } catch (err) {
    // A starter that throws is a poisoned row, not a broken queue: letting the
    // rejection escape would reject `pump` (usually called unawaited from a
    // runner's epilogue) and leave the slot reserved for the rest of the
    // session, wedging every later job. Rust cannot reach this state — its
    // starters return `Result` — so this is the port's equivalent guarantee.
    result = { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }

  if (result.kind === "runner") {
    return "runner";
  }
  if (result.kind === "immediate") {
    // Finished without a runner: drop the flag and free the slot so the pump
    // continues.
    deps.cancelState.jobCancels.delete(jobId);
    freeSlot(deps.state, jobId);
    return "continue";
  }
  // Poisoned row: mark it 'error' (the Sidebar shows Retry), drop the flag,
  // free the slot, and let the caller pump the next queued row. If the room
  // refused that write — or the room went away underneath us — the row is STILL
  // 'queued', so continuing would re-pick it immediately and spin at full
  // processor speed. Report Stuck instead and leave the queue for the next pump.
  const writeRoom = deps.rooms.current();
  let marked = false;
  if (writeRoom !== null) {
    try {
      setJobStatus(writeRoom.db, jobId, "error", result.message);
      marked = true;
    } catch {
      marked = false;
    }
  }
  deps.cancelState.jobCancels.delete(jobId);
  freeSlot(deps.state, jobId);
  return marked ? "continue" : "stuck";
}

/** Submit a freshly-created (or re-queued) job. Starts it now if the slot is
 * free, else leaves the row 'queued' for a later {@link pump}. */
export async function submit(deps: JobQueueDeps, jobId: string): Promise<void> {
  if (!tryReserve(deps.state, jobId)) {
    return;
  }
  // Only a spawned RUNNER holds the slot; anything else (finished-sync, or a
  // poisoned row that freed the slot) means we pump the next waiter. "stuck"
  // means the room could not even record the failure — pumping would just
  // re-pick the same row, so stop.
  if ((await startJobFromRow(deps, jobId)) === "continue") {
    await pump(deps);
  }
}

/** Clear the slot (only if this job holds it) and start the next queued job.
 * Called from EVERY job's terminal epilogue — every real {@link RowStarter}
 * this batch wires passes an `onSettled` that calls back into this (see
 * {@link runnerDepsFrom}). */
export async function finishAndPump(deps: JobQueueDeps, jobId: string): Promise<void> {
  freeSlot(deps.state, jobId);
  await pump(deps);
}

/**
 * Start the oldest queued job of the CURRENT room, if the slot is free. Loops
 * over poisoned rows (a start that fails is marked 'error' and skipped) so the
 * queue never head-of-line-blocks. Room-pinned: only the open room's queue
 * runs.
 *
 * HARDENING beyond the Rust source: a row is picked at most once per pass. The
 * loop's contract is that a "continue" outcome has taken the row off 'queued'
 * (either a terminal status the starter wrote, or the 'error' the poisoned path
 * wrote), and Rust's own starters all keep it. A starter that reports
 * "immediate" WITHOUT writing a terminal status would otherwise be handed the
 * same row forever, at full processor speed, with no way out — so a second
 * sighting ends the pass instead.
 */
export async function pump(deps: JobQueueDeps): Promise<void> {
  const picked = new Set<string>();
  for (;;) {
    if (!slotFreeForThisRoom(deps.state, deps.rooms)) {
      return; // slot busy — the running job's epilogue will pump next
    }
    const room = deps.rooms.current();
    if (room === null) {
      return;
    }
    let nextId: string | null;
    try {
      nextId = unfinishedJobs(room.db).find((j) => j.status === "queued")?.id ?? null;
    } catch {
      // A failed READ is not "nothing is waiting": treat it as a stop, never as
      // an empty queue, so a transient DB error can't silently retire the queue
      // for the rest of the session (the next finishAndPump retries).
      return;
    }
    if (nextId === null || picked.has(nextId)) {
      return;
    }
    picked.add(nextId);
    if (!tryReserve(deps.state, nextId)) {
      return; // someone reserved between the check and here
    }
    if ((await startJobFromRow(deps, nextId)) !== "continue") {
      return; // Runner: its epilogue pumps next. Stuck: don't spin on it.
    }
  }
}

/** Wave 4a: called from room open to restart any work left 'queued' from a
 * previous session (open decision 2: auto-start at unlock). Fire-and-forget,
 * matching Rust's own `tauri::async_runtime::spawn` wrapper around `pump`. */
export function pumpOnOpen(deps: JobQueueDeps): void {
  void pump(deps);
}
