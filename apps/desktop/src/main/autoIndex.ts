/**
 * Wave 1b (idea 8): always-on indexing — the debounced scheduler that turns
 * "files were imported/OCR'd/transcribed" into `ai_summary` coverage without
 * the user pressing Summarize, and reads recordings the room has never read.
 *
 * Ported from `src-tauri/src/commands/jobs/auto_index.rs` (263 lines, read in
 * full, including its `#[cfg(test)] mod tests`).
 *
 * Shape, preserved from the Rust source: every ingest event calls
 * {@link scheduleAutoIndex}, which bumps a generation stamp and spawns one
 * waiter. The waiter debounces (~30 s, so a multi-file drop coalesces),
 * re-checks it is still the LATEST waiter, then runs the pure
 * {@link autoIndexDecision}: tiny drops go through the quiet opportunistic
 * filler (no job card), big drops become one visible, cancellable, resumable
 * "Indexing new files" job over the MISSING-summary set, busy moments retry
 * bounded, and a room with no model installed skips. On the SAME tick, before
 * any of that, the room reads ONE recording it has never read — same debounce,
 * same busy probes, same model probe. Deliberately NOT a second scheduler: two
 * debounced waiters racing the same room is how a quiet Mac ends up grinding
 * through the model twice over.
 *
 * INTEGRATION DECISION (2026-07-18, master plan Wave 1b), carried over from the
 * Rust module header: this module and `start_deep_summary_inner(auto = true)`
 * are the ONE auto-index entry point. Wave 4a's "new-file summarizer" workflow
 * template must call this same machinery — it must NOT duplicate the scheduler,
 * the missing-set plan, or the sentinel policy.
 *
 * WHAT IS FULLY REAL HERE, against already-ported dependencies:
 *  - {@link autoIndexDecision} — the pure policy, unit-tested exhaustively in
 *    `autoIndex.test.ts` with the Rust suite's own table.
 *  - {@link runAutoIndexPass} — one debounce-elapsed check: the `auto_index`
 *    setting read (`db-host/settings.ts`), the missing-summary count
 *    (`db-host/files.ts`), the unread-recording probe
 *    (`db-host/recordings.ts`), the busy probes (`cancel.ts`'s real
 *    `CancelState.cancels`/`.jobCancels`), the model probe, the room pin, the
 *    generation re-checks at both points Rust makes them, and — on the StartJob
 *    decision — retiring any stale unfinished auto `deep_summary` job through
 *    the real `unfinishedJobs`/`deleteJob` (`db-host/jobs.ts`).
 *  - {@link runAutoIndex}/{@link scheduleAutoIndex} — the debounce, the
 *    bounded retry loop, and the generation race (a later ingest's waiter owns
 *    the run).
 *
 * WHAT IS AN HONEST STUB, and why: the two calls this scheduler makes when it
 * decides real work should start — `start_deep_summary_inner` (`jobs.rs`:
 * builds the missing-file plan, resolves the engine/model, spawns the per-file
 * summarizer; excluded by name in `jobs.ts`'s own "WHAT IS DELIBERATELY OUT OF
 * SCOPE") and `start_rec_read` (`jobs/rec_read.rs`: partitions a transcript
 * into read windows and spawns the reading-pass runner, a separate batch) — are
 * each a whole unported subsystem, not a small helper. Following this
 * codebase's "stub, don't fake" convention (`jobs.ts`'s
 * `renderPodcastAudioNotImplemented`, `jobScheduler.ts`'s
 * `startWorkflowRunNotImplemented`), both are injectable seams —
 * {@link StartDeepSummaryAuto}, {@link StartRecRead} — with a stub to wire in
 * meanwhile ({@link startDeepSummaryAutoNotImplemented},
 * {@link startRecReadNotImplemented}) that rejects with a clearly-labeled
 * `NOT_IMPLEMENTED: …` reason. Note they are REQUIRED fields of
 * {@link AutoIndexDeps}, never silently defaulted: a production wiring that
 * forgets one fails to compile rather than quietly indexing nothing, which is
 * the only thing that keeps a stub honest once this module has real callers.
 * A rejection flows through
 * EXACTLY the branch Rust's own `let _ = start_deep_summary_inner(...).await;`
 * and `if start_rec_read(...).await.is_ok() { return; }` already treat a real
 * failure as: the StartJob branch still ends the tick (Rust discards the
 * result unconditionally), and the recording-read branch FALLS THROUGH to the
 * ordinary summary decision on the same tick — an `Err` does NOT return, which
 * is the whole point of the Rust comment there. Driving either job kind for
 * real is a matter of supplying a real function to {@link AutoIndexDeps}; no
 * change to this file's logic.
 *
 * `spawn_summary_filler` (`stt_cmds.rs`) — the QUIET, non-durable,
 * single-flight opportunistic filler the QuietFiller decision drives — is a
 * third, separate unported feature (its own single-flight flag, per-file model
 * calls, a `room-files-changed` announce on exit). It returns nothing in Rust
 * ("all failures are silent" is its own doc), so there is no Result to reject;
 * {@link SpawnSummaryFiller} is a `void` seam whose stub LOGS the labeled
 * reason rather than silently doing nothing — a silent no-op is exactly what a
 * forgotten production wiring would look like, and a throw would take a
 * scheduler tick down over a feature whose whole point is that it is
 * unnoticeable.
 *
 * DEVIATION — no `main_window(app)`: the same deviation `jobScheduler.ts`
 * already documents for the same gap. Rust bails the recording-read attempt and
 * the StartJob dispatch when there is no live window to run in; that check
 * folds into the `rooms.current() !== null` guard every read/write here already
 * makes, rather than inventing a window handle this rewrite has no port for.
 *
 * DEVIATION — {@link AutoIndexOpts}: the debounce and retry intervals are
 * overridable, so the timer tests run in milliseconds instead of tens of
 * seconds. `jobScheduler.ts`'s `spawnWorkflowScheduler(deps, state, tickMs)`
 * sets the identical precedent. The retry BOUND is not overridable — it is the
 * Rust constant, and a test that could move it would not be testing the bound.
 */

import type { CancelState } from "./cancel.js";
import { filesMissingSummary } from "./db-host/files.js";
import { type Job, deleteJob, unfinishedJobs } from "./db-host/jobs.js";
import { recordingsMissingRead } from "./db-host/recordings.js";
import { getSetting } from "./db-host/settings.js";
import { listModels as listModelsReal } from "./engineRouting.js";
import type { RoomHandle, RoomSource } from "./jobs.js";
import {
  START_DEEP_SUMMARY_NOT_IMPLEMENTED,
  START_REC_READ_NOT_IMPLEMENTED,
  SUMMARY_FILLER_NOT_IMPLEMENTED,
  spawnSummaryFillerNotImplemented,
  startDeepSummaryAutoNotImplemented,
  startRecReadNotImplemented,
  type SpawnSummaryFiller,
  type StartDeepSummaryAuto,
  type StartRecRead,
} from "./autoIndexActions.js";
import {
  QUIET_FILLER_MAX,
  autoIndexDecision,
  type AutoIndexDecision,
} from "./autoIndexPolicy.js";

export {
  QUIET_FILLER_MAX,
  START_DEEP_SUMMARY_NOT_IMPLEMENTED,
  START_REC_READ_NOT_IMPLEMENTED,
  SUMMARY_FILLER_NOT_IMPLEMENTED,
  autoIndexDecision,
  spawnSummaryFillerNotImplemented,
  startDeepSummaryAutoNotImplemented,
  startRecReadNotImplemented,
};
export type {
  AutoIndexDecision,
  SpawnSummaryFiller,
  StartDeepSummaryAuto,
  StartRecRead,
};

// ============================================================================
// Constants — verbatim from auto_index.rs
// ============================================================================

/** Debounce between the ingest event and the indexing decision. Also replaces
 * the quiet filler's own 45 s head start (the filler is invoked with delay 0
 * once this debounce has already passed, so tiny drops don't wait ~75 s). */
export const AUTO_INDEX_DEBOUNCE_SECS = 30;
/** While a question streams or another job runs, retry this often… */
const AUTO_INDEX_RETRY_SECS = 60;
/** …at most this many times (a fresh import re-arms from zero). */
const AUTO_INDEX_MAX_RETRIES = 10;
// ============================================================================
// The pure policy — auto_index_decision
// ============================================================================

// ============================================================================
// The three unported actions — injectable seams, "stub, don't fake"
// ============================================================================

// ============================================================================
// The debounced dispatch — schedule_auto_index
// ============================================================================

/** Generation stamp for the debounced waiter — the same pattern
 * `jobScheduler.ts`'s `SchedulerState` uses (and Rust's own
 * `auto_index_generation`/`embed_generation` before it): every ingest event
 * bumps it and spawns one waiter carrying the new stamp; a waiter whose stamp
 * has gone stale exits, so a multi-file drop coalesces into exactly one run. */
export interface AutoIndexState {
  generation: number;
}

export function createAutoIndexState(): AutoIndexState {
  return { generation: 0 };
}

/** Everything {@link runAutoIndexPass}/{@link scheduleAutoIndex} need beyond
 * the room — see this module's doc for why each is a seam. */
export interface AutoIndexDeps {
  rooms: RoomSource;
  /** `AppState.cancels`/`.job_cancels`, reused via `cancel.ts`'s own
   * `CancelState` — its two flat registries ARE the exact ones Rust's `asking`
   * / `job_running` probes poll. */
  cancelState: CancelState;
  startDeepSummaryAuto: StartDeepSummaryAuto;
  startRecRead: StartRecRead;
  spawnSummaryFiller: SpawnSummaryFiller;
  /** `ollama::list_models` — defaults to the REAL, already-ported
   * `engineRouting.ts` implementation (which never throws: an unreachable
   * daemon already resolves to `[]`, matching Rust's `.unwrap_or_default()`),
   * following `turnEngine.ts`'s optional-with-real-default convention for this
   * same dependency. */
  listModels?: () => Promise<string[]>;
}

/** Timing knobs, overridable so tests never wait on the real 30 s/60 s. */
export interface AutoIndexOpts {
  debounceMs?: number;
  retryMs?: number;
}

/**
 * How one pass ended. Exported so a caller or a test can assert on the decision
 * a tick actually made, without waiting through {@link scheduleAutoIndex}'s own
 * timers.
 *
 * `"recRead"` is reported ONLY for a read that actually started — a refused
 * attempt spends nothing and falls through to the summary decision, so the
 * outcome it reports is that decision's, exactly as in Rust.
 */
export type AutoIndexOutcome =
  /** The generation moved (a newer schedule call owns the run), or the room
   * this pass started for is no longer the one open. Rust's several bare
   * `return`s for exactly those two reasons collapse to this one outcome,
   * matching that neither is distinguished on the Rust side either. */
  | { readonly kind: "stale" }
  | { readonly kind: "skip" }
  | { readonly kind: "quietFiller" }
  | { readonly kind: "recRead"; readonly fileId: string }
  /** `jobId` is `null` when the starter refused — Rust discards that result
   * too, but the caller of a single pass can still see what happened. */
  | { readonly kind: "startJob"; readonly jobId: string | null }
  /** Busy — {@link runAutoIndex} sleeps and tries again, bounded. */
  | { readonly kind: "retry" };

/** Sleep without holding the process open on the timer alone — the same helper,
 * of the same shape, `jobScheduler.ts` keeps privately: this is a background
 * loop, and nothing about the app's lifetime should depend on it being
 * mid-wait. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer: unknown = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function currentRoomAtPath(rooms: RoomSource, roomPath: string): RoomHandle | null {
  const room = rooms.current();
  if (room === null || room.path !== roomPath) {
    return null;
  }
  return room;
}

function unfinishedJobsOrNone(room: RoomHandle): Job[] {
  try {
    return unfinishedJobs(room.db);
  } catch {
    return [];
  }
}

function isAutoDeepSummaryJob(job: Job): boolean {
  return job.kind === "deep_summary" && isRecord(job.plan) && job.plan["auto"] === true;
}

function deleteJobBestEffort(room: RoomHandle, jobId: string): void {
  try {
    deleteJob(room.db, jobId);
  } catch {
    // best-effort, mirrors Rust's `let _ = db::delete_job(...)`.
  }
}

/**
 * Job-lifecycle amendment (ported from the `StartJob` arm's own comment): any
 * unfinished auto deep-summary job (parked 'paused' by quiesce after a quit
 * mid-run, or left 'queued'/'running') is strictly superseded by the fresh
 * missing-set plan about to be built — delete it so stale Resume cards don't
 * stack. A MANUAL deep-summary job (`auto` absent or `false`) is something the
 * user asked for by name and is left alone.
 *
 * Best-effort and room-pinned, matching the Rust source's `let _ =
 * state.with_room(|room| { if room.path != room_path { return Ok(()) } … })`:
 * a room that has since closed or swapped, or a read/delete that fails, must
 * not take the rest of the tick down with it.
 */
function retireUnfinishedAutoDeepSummaryJobs(rooms: RoomSource, roomPath: string): void {
  const room = currentRoomAtPath(rooms, roomPath);
  if (room === null) {
    return;
  }
  for (const job of unfinishedJobsOrNone(room)) {
    if (isAutoDeepSummaryJob(job)) {
      deleteJobBestEffort(room, job.id);
    }
  }
}

/** The `auto_index` setting and the missing-summary count, read under the room
 * pin in one go — Rust's single `(setting_on, missing, still_open)` tuple.
 * `null` is its `still_open == false`. Both reads swallow their own errors
 * exactly as Rust does (`get_setting` ends in `.ok()`, so a failed read is
 * `None`, which reads as ON; `files_missing_summary` is `.unwrap_or(0)`). */
function readRoomState(
  rooms: RoomSource,
  roomPath: string
): { settingOn: boolean; missing: number } | null {
  const room = rooms.current();
  if (room === null || room.path !== roomPath) {
    return null;
  }
  let setting: string | null = null;
  try {
    setting = getSetting(room.db, "auto_index");
  } catch {
    setting = null;
  }
  let missing = 0;
  try {
    missing = filesMissingSummary(room.db, QUIET_FILLER_MAX + 1).length;
  } catch {
    missing = 0;
  }
  return { settingOn: setting !== "0", missing };
}

/** The single MOST RECENT recording this room has never read, under the room
 * pin — `recordings_missing_read` orders `created_at DESC`, so the newest
 * unread one is what a `LIMIT 1` returns, and the thing you just recorded is
 * read before a backlog older than it. Rust's
 * `db::recordings_missing_read(&room.conn, 1).unwrap_or_default()`
 * inside its own `match guard.as_ref()`. ONE per tick: the queue serializes
 * them anyway, and the next ingest (or the next recording stopped) re-arms the
 * waiter, so an unread backlog drains steadily instead of all at once. */
function nextUnreadRecording(rooms: RoomSource, roomPath: string): string | undefined {
  const room = rooms.current();
  if (room === null || room.path !== roomPath) {
    return undefined;
  }
  try {
    return recordingsMissingRead(room.db, 1)[0];
  } catch {
    return undefined;
  }
}

type AutoIndexPassContext = Pick<AutoIndexDeps, "rooms" | "cancelState" | "startDeepSummaryAuto" | "startRecRead" | "spawnSummaryFiller"> & {
  readonly generationIsCurrent: () => boolean;
  readonly roomPath: string;
};

interface AutoIndexReadiness {
  readonly settingOn: boolean;
  readonly missing: number;
  readonly modelsAvailable: boolean;
  readonly jobRunning: boolean;
  readonly asking: boolean;
}

function staleAutoIndexOutcome(): AutoIndexOutcome {
  return { kind: "stale" };
}

async function modelsAreAvailable(listModels: () => Promise<string[]>): Promise<boolean> {
  return (await listModels()).length > 0;
}

function configuredModelLister(deps: Pick<AutoIndexDeps, "listModels">): () => Promise<string[]> {
  return deps.listModels ?? listModelsReal;
}

function canReadUnreadRecording(readiness: AutoIndexReadiness): boolean {
  return (
    readiness.settingOn &&
    readiness.modelsAvailable &&
    !readiness.jobRunning &&
    !readiness.asking
  );
}

async function startUnreadRecording(
  deps: Pick<AutoIndexDeps, "startRecRead">,
  roomPath: string,
  fileId: string
): Promise<boolean> {
  try {
    await deps.startRecRead(roomPath, fileId);
    return true;
  } catch {
    return false;
  }
}

async function unreadRecordingOutcome(
  context: AutoIndexPassContext,
  readiness: AutoIndexReadiness
): Promise<AutoIndexOutcome | null> {
  if (!canReadUnreadRecording(readiness)) {
    return null;
  }
  const fileId = nextUnreadRecording(context.rooms, context.roomPath);
  if (fileId === undefined) {
    return null;
  }
  if (await startUnreadRecording(context, context.roomPath, fileId)) {
    return { kind: "recRead", fileId };
  }
  return context.generationIsCurrent() ? null : staleAutoIndexOutcome();
}

async function startAutoIndexJob(context: AutoIndexPassContext): Promise<AutoIndexOutcome> {
  retireUnfinishedAutoDeepSummaryJobs(context.rooms, context.roomPath);
  if (context.rooms.current() === null) {
    return staleAutoIndexOutcome(); // folded main_window check — see module doc
  }
  let jobId: string | null = null;
  try {
    jobId = await context.startDeepSummaryAuto(context.roomPath);
  } catch {
    jobId = null; // matches Rust's `let _ = start_deep_summary_inner(...)`
  }
  return { kind: "startJob", jobId };
}

async function autoIndexDecisionOutcome(
  context: AutoIndexPassContext,
  readiness: AutoIndexReadiness
): Promise<AutoIndexOutcome> {
  switch (
    autoIndexDecision(
      readiness.settingOn,
      readiness.missing,
      readiness.jobRunning,
      readiness.asking,
      readiness.modelsAvailable
    )
  ) {
    case "skip":
      return { kind: "skip" };
    case "quietFiller":
      // Delay 0: this waiter already debounced (addendum fix — the filler's
      // own 45 s head start would otherwise stack on top).
      context.spawnSummaryFiller(context.roomPath, 0);
      return { kind: "quietFiller" };
    case "retry":
      return { kind: "retry" };
    case "startJob":
      return startAutoIndexJob(context);
  }
}

/**
 * One pass of the debounced check: read the room's live state, try the
 * recording-read priority arm, then fall back to {@link autoIndexDecision} and
 * act on it. Run once after the initial debounce and once per bounded retry by
 * {@link runAutoIndex}, which owns the sleeping.
 *
 * `generation` is the stamp THIS waiter was spawned with. The pass re-checks
 * `state.generation === generation` at the three points the Rust loop does: on
 * entry (its loop top), right after the model probe's await, and again after a
 * refused rec-read attempt's await — the moments something else could have
 * raced ahead of this waiter.
 */
export async function runAutoIndexPass(
  deps: AutoIndexDeps,
  state: AutoIndexState,
  generation: number,
  roomPath: string
): Promise<AutoIndexOutcome> {
  const context: AutoIndexPassContext = {
    ...deps,
    generationIsCurrent: () => state.generation === generation,
    roomPath,
  };
  const listModels = configuredModelLister(deps);

  // A later ingest re-armed the debounce — that waiter owns the run.
  if (!context.generationIsCurrent()) {
    return staleAutoIndexOutcome();
  }

  const room = readRoomState(deps.rooms, roomPath);
  if (room === null) {
    return staleAutoIndexOutcome();
  }
  const readiness: AutoIndexReadiness = {
    ...room,
    asking: deps.cancelState.cancels.size > 0,
    jobRunning: deps.cancelState.jobCancels.size > 0,
    modelsAvailable: await modelsAreAvailable(listModels),
  };
  // The model probe awaited — a newer waiter may own the run now.
  if (!context.generationIsCurrent()) {
    return staleAutoIndexOutcome();
  }

  // The room reads recordings it has never read, on the same tick as the
  // summary sweep — same debounce, same busy probes, same model probe (see
  // this module's doc for why this is not a second scheduler). `settingOn`
  // gates this arm too: reading a recording the room has never read IS
  // describing a new file with the local AI, exactly what the switch says it
  // controls, so leaving it out meant the box could be off while the same tick
  // still spent the room's one model lane. Half a switch is the same defect as
  // no switch, only harder to notice.
  const recordingOutcome = await unreadRecordingOutcome(context, readiness);
  if (recordingOutcome !== null) {
    return recordingOutcome;
  }
  return autoIndexDecisionOutcome(context, readiness);
}

/**
 * Debounce + bounded-retry dispatch, run to completion — the awaitable core
 * {@link scheduleAutoIndex} fires without awaiting, exactly as Rust's
 * `tauri::async_runtime::spawn` wrapper does. Exported separately (as
 * `jobScheduler.ts` exports `tick`/`catchUpPass` alongside its own spawn
 * wrapper) so tests can await one whole run instead of racing a detached task.
 *
 * Resolves with the outcome the run ended on. Hitting the retry bound resolves
 * with the last `{ kind: "retry" }`: the room was still busy when this waiter
 * gave up, and the next ingest re-arms from zero.
 */
export async function runAutoIndex(
  deps: AutoIndexDeps,
  state: AutoIndexState,
  generation: number,
  roomPath: string,
  opts: AutoIndexOpts = {}
): Promise<AutoIndexOutcome> {
  const debounceMs = opts.debounceMs ?? AUTO_INDEX_DEBOUNCE_SECS * 1000;
  const retryMs = opts.retryMs ?? AUTO_INDEX_RETRY_SECS * 1000;

  await sleep(debounceMs);

  let retries = 0;
  for (;;) {
    const outcome = await runAutoIndexPass(deps, state, generation, roomPath);
    if (outcome.kind !== "retry") {
      return outcome;
    }
    retries += 1;
    if (retries > AUTO_INDEX_MAX_RETRIES) {
      return outcome; // bounded; the next ingest re-arms from zero
    }
    await sleep(retryMs);
  }
}

/**
 * Bump the generation and spawn one debounced waiter — Rust's
 * `schedule_auto_index`. Called at the end of `import_files`, `run_ocr_job` and
 * `run_stt_job` (after their locks drop), replacing the direct
 * `spawn_summary_filler` calls — so import latency is untouched and repeated
 * drops re-arm the same single waiter.
 *
 * Fire-and-forget, matching `tauri::async_runtime::spawn`. Returns the
 * generation it runs under, mirroring `spawnWorkflowScheduler`'s own return, so
 * a caller or test can tell which waiter is live. Rust has no separate "stop":
 * a new `schedule_auto_index` call is the only thing that ever retires a
 * waiter, which is exactly what bumping `state.generation` here does.
 */
export function scheduleAutoIndex(
  deps: AutoIndexDeps,
  state: AutoIndexState,
  roomPath: string,
  opts: AutoIndexOpts = {}
): number {
  const generation = state.generation + 1;
  state.generation = generation;
  // A detached waiter must not be able to take the app down. Rust gets that
  // floor for free — `tauri::async_runtime::spawn` parks a failed task in its
  // JoinHandle nobody joins — while a bare `void runAutoIndex(...)` would let
  // any throw out of a caller-supplied seam (`spawnSummaryFiller` is `void`, so
  // a throw is its ONLY way to fail; `rooms.current()` is called unguarded
  // three times a tick) escape as an unhandled rejection, which Node has thrown
  // on by default since v15 and Electron's main process does not survive. Every
  // room READ inside the pass is already best-effort; this is the floor under
  // everything else. Reported, not swallowed: a background loop that stopped
  // for an unknown reason is exactly what this module refuses to be.
  void runAutoIndex(deps, state, generation, roomPath, opts).catch((err: unknown) => {
    console.error(`auto-index waiter ${generation} failed for ${roomPath}:`, err);
  });
  return generation;
}
