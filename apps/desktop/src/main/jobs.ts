/**
 * ADD-30: the job runner's FOUNDATION. A heavy operation (deep summary, media
 * digest) is a `Plan` — a DAG of `Step`s tagged with a `Lane`. The scheduler
 * dispatches every step whose dependencies are met and whose lane has a free
 * slot, runs them, checkpoints to the `jobs` table, and reports progress.
 * Parallelism is per-lane: local models are serial (one resident model), CPU
 * and cloud work run several at once.
 *
 * Ported from `src-tauri/src/commands/jobs.rs` (2786 lines, read in full), per
 * that module's own doc comment: "This module is the *foundation*.
 * `plan_dispatch` (the scheduling decision) is pure and unit-tested; `run_plan`
 * drives it; `execute_step` maps a step to real work."
 *
 * WHAT IS PORTED, with the Rust source's own `#[cfg(test)]` fixtures as the
 * primary coverage (see `jobs.test.ts`):
 *   - {@link Lane} / {@link laneSlots} — where a step runs, how many at once.
 *   - {@link Step} / {@link Plan} — one DAG node, and the stored envelope.
 *   - {@link planDispatch} — the pure scheduling decision (jobs.rs:97-124).
 *   - {@link planComplete} / {@link planIsStuck} — completion and deadlock
 *     detection (jobs.rs:127-138).
 *   - {@link densePrefix} — the largest contiguous done-prefix, the only valid
 *     scalar resume cursor (jobs.rs:151-153).
 *   - {@link RunOutcome} / {@link runPlan} — drives a plan wave by wave,
 *     checkpointing and reporting progress after each (jobs.rs:155-221).
 *   - {@link PARKED_BY_LOCK} / {@link PARKED_BY_EXIT} / {@link markJobsParking}
 *     / {@link parkRunningJobs} / {@link quiesceStaleJobs} /
 *     {@link parkCrashedJob} — the job-lifecycle housekeeping that needs only a
 *     `Database` connection (jobs.rs:284-399).
 *   - {@link crashReason} / {@link spawnJobRunner} — `panic_reason` /
 *     `spawn_job_runner` (jobs.rs:401-474): a runner's own uncaught failure
 *     must still leave the row terminal and the queue pumped.
 *   - {@link spawnPodcastAudio} — `spawn_podcast_audio` (jobs.rs:1019-1087).
 *
 * WHAT IS DELIBERATELY OUT OF SCOPE, and why: every OTHER job-kind spawner in
 * `jobs.rs` (`spawn_deep_summary`/`start_deep_summary_inner`, `spawn_studio`/
 * `start_studio_job_inner`, `resume_job`, `begin_file_pass`/`spawn_file_pass`,
 * `deep_summary_plan`, `resolve_pass_engine`) reaches into subsystems this
 * rewrite has not ported: `AppState`/`tauri::Window`, `ollama::list_models` /
 * `capabilities::runs_on_this_mac` (engine routing), `extraction::smart_filter`
 * / `partition_windows`, and the `file_pass`/`auto_index`/`workflow`/
 * `script_run`/`download`/`create`/`rec_read` sub-modules reserved for future
 * batches. Porting any of them now would mean inventing stand-ins for all of
 * them at once — the opposite of "foundation". `list_jobs`/`cancel_job`/
 * `delete_job` (the three plain `#[tauri::command]`s) are likewise deferred:
 * they are one-line wrappers over `db-host/jobs.ts` and `cancel.ts` plus an
 * `AppState` parameter this batch does not invent.
 *
 * ## `spawn_podcast_audio`: what it actually needs
 *
 * Reading jobs.rs:1019-1087 in full, its REAL work is exactly one call,
 * `crate::commands::render_podcast_audio` — which itself depends on
 * `db::get_podcast` (a podcast/studio DB module with no port yet) and the TTS
 * voice service (the sidecar's `/tts` lane). Everything AROUND that call — flip
 * the row to 'running', emit the opening progress line, treat any failure while
 * cancelled as a clean Pause (the same convention `spawn_studio` uses), write
 * the terminal status, clear the cancel registration, emit the terminal
 * `job-progress` event, free the queue slot — is ordinary job-lifecycle
 * plumbing this batch has every piece of, and is ported for real and fully
 * tested. Only the render call is a seam: an injectable
 * {@link RenderPodcastAudio} defaulting to
 * {@link renderPodcastAudioNotImplemented}, which fails with a clearly-labeled
 * `NOT_IMPLEMENTED: …` reason ("stub, don't fake" — `execTool.ts`'s
 * `notImplemented` convention). Calling it today drives the job down the exact
 * error path a genuine TTS outage would: row → 'error', terminal event with
 * `failed: true`. Never a silent success, never an unhandled rejection.
 *
 * ## No `AppState` port exists yet
 *
 * `jobs.rs`'s runners reach a `tauri::State<'_, AppState>` for the open room,
 * the single running-job slot, and the per-job cancel flags. None of that has
 * an Electron port (`cancel.ts` documents the same gap for its own slice), so
 * this file declares minimal, explicitly-named seams — {@link RoomSource},
 * {@link ProgressSink}, {@link JobRunnerDeps} — following the convention
 * `roomPin.ts`'s `RoomPinSource` and `execTool.ts`'s `ExecToolDeps` set. The
 * cancel primitive is NOT re-invented: `cancel.ts`'s `CancelFlag` is the app's
 * one cancellation type and is imported as-is.
 *
 * DEVIATION — `Step.dependsOn` is camelCase where the Rust `Step` struct (no
 * `#[serde(rename_all)]`) serializes its own field as `depends_on`. This is the
 * RUNTIME shape `planDispatch`/`runPlan` operate on; whichever future batch
 * first deserializes a legacy room's stored `jobs.plan` into a `Step[]` needs a
 * `depends_on` ↔ `dependsOn` adapter at that one seam.
 *
 * DEVIATION — a step's outcome is a VALUE ({@link StepResult}), not a thrown
 * exception, mirroring Rust's `Result<(), String>` (`cancel.ts`'s `GuardResult`
 * is the established precedent in `src/main`, as opposed to `db-host`'s
 * throws-Error convention). This is load-bearing, not stylistic: {@link runPlan}
 * runs a wave via `Promise.all`, and a wave where step 2 of 4 REJECTS would
 * short-circuit on the first rejection — abandoning steps 0/1/3 as
 * unhandled-rejection noise instead of running all four to completion the way
 * Rust's `join_all` does (see `run_plan_discards_a_failed_waves_completed_
 * siblings`, ported from the Rust test of the same name).
 */

import type { CancelFlag } from "./cancel.js";
import { setJobStatus } from "./db-host/jobs.js";
import {
  crashReason,
  emitProgress,
  parkCrashedJob,
  pinnedDb,
  type ProgressSink,
  type RoomSource,
} from "./jobsLifecycle.js";

export * from "./jobsLifecycle.js";
export * from "./jobsPlan.js";



/** Everything a job runner needs beyond its own step logic: where the open room
 * is, where progress events go, how to release this job's cancel flag, and how
 * to free the queue slot and pump the next waiter once this job is terminal. */
export interface JobRunnerDeps {
  rooms: RoomSource;
  sink: ProgressSink;
  /** Remove this job's cancel flag from whatever registry holds it (Rust:
   * `state.job_cancels.lock().unwrap().remove(&job_id)`). Called once on every
   * path that reaches a terminal state — the runner's own epilogue AND
   * {@link spawnJobRunner}'s crash branch each call it exactly once, matching
   * the two places the Rust source does. */
  removeCancelFlag: (jobId: string) => void;
  /** Free the single running-job slot and start the next queued job (Rust:
   * `queue::finish_and_pump`) — `jobQueue.ts` supplies this in production.
   * Injected rather than imported so this file does not depend on the queue,
   * mirroring the Rust layering (`mod queue` is declared alongside
   * `commands/jobs.rs`, not underneath it). */
  onSettled: (jobId: string) => void | Promise<void>;
}

type ParkedJobProgress = { cursor: number; total: number } | null;

function parkRunnerCrash(deps: JobRunnerDeps, jobId: string, roomPath: string, reason: string): ParkedJobProgress {
  const db = pinnedDb(deps.rooms, roomPath);
  if (db === null) {
    return null;
  }
  try {
    return parkCrashedJob(db, jobId, reason);
  } catch {
    return null;
  }
}

function removeRunnerCancelFlag(deps: JobRunnerDeps, jobId: string): void {
  try {
    deps.removeCancelFlag(jobId);
  } catch {
    // The queue must still be pumped if its cancellation registry is gone.
  }
}

function emitRunnerCrash(
  sink: ProgressSink,
  jobId: string,
  reason: string,
  parked: ParkedJobProgress,
): void {
  if (parked === null) {
    return;
  }
  try {
    sink.emit({
      jobId,
      label: `Stopped — ${reason}`,
      done: parked.cursor,
      total: parked.total,
      failed: true,
    });
  } catch {
    // A broken renderer channel must not cost the queue its slot.
  }
}

async function settleRunner(deps: JobRunnerDeps, jobId: string): Promise<void> {
  try {
    await deps.onSettled(jobId);
  } catch {
    // Re-throwing from the recovery path would be an unhandled rejection.
  }
}

async function handleRunnerCrash(
  deps: JobRunnerDeps,
  jobId: string,
  roomPath: string,
  err: unknown,
): Promise<void> {
  const reason = crashReason(err);
  // Mirrors the Rust source's own `eprintln!` — the host has no log sink here.
  console.error(`job ${jobId} runner crashed: ${reason}`);
  const parked = parkRunnerCrash(deps, jobId, roomPath, reason);
  removeRunnerCancelFlag(deps, jobId);
  emitRunnerCrash(deps.sink, jobId, reason, parked);
  await settleRunner(deps, jobId);
}

async function runJobRunner(
  deps: JobRunnerDeps,
  jobId: string,
  roomPath: string,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (err) {
    await handleRunnerCrash(deps, jobId, roomPath, err);
  }
}

/**
 * Run a job runner's body with a terminal state GUARANTEED on every exit —
 * including the one nobody writes code for.
 *
 * Ported from `spawn_job_runner`. Rust needs it because
 * `tauri::async_runtime::spawn` drops its `JoinHandle`, so a panic anywhere in
 * a runner is completely silent: the row stays 'running' for the whole session
 * — a Sidebar card with a live progress bar for work nothing is doing, behind
 * it a queue that will never start another job — and only the next room open
 * reconciles it. The JS equivalent gap is a rejected promise nobody awaits (a
 * fire-and-forget spawn); same silent failure mode, same fix.
 *
 * `body` runs its OWN epilogue on every path IT knows about (terminal DB write,
 * cancel-flag removal, terminal event, `onSettled` pump); this wrapper's
 * `catch` is only for the path nothing anticipated.
 *
 * Returns the settled promise rather than firing-and-forgetting internally
 * (Rust's `spawn` has no return value a caller could await either): a real
 * caller simply does not await it, exactly as Rust's callers never join the
 * spawned task, but a test can — the crash path especially has nothing else to
 * synchronize on.
 */
export function spawnJobRunner(
  deps: JobRunnerDeps,
  jobId: string,
  roomPath: string,
  body: () => Promise<void>
): Promise<void> {
  return runJobRunner(deps, jobId, roomPath, body);
}

// ============================================================================
// spawn_podcast_audio
// ============================================================================

/** What actually turns a podcast script into audio — Rust's
 * `crate::commands::render_podcast_audio`, which drives the TTS voice service
 * turn by turn. Wholly unported (studio/TTS is a future batch). Resolves to the
 * generated file's metadata (only its `id` is read, exactly as the Rust runner
 * reads `meta.id`); a failure may be reported either by rejecting or by
 * throwing — {@link spawnPodcastAudio} treats both the same way Rust treats
 * `Err(e)`. */
export type RenderPodcastAudio = (
  scriptFileId: string,
  cancel: CancelFlag
) => Promise<{ readonly id: string }>;

/** The labeled reason the stubbed renderer fails with. Exported so a caller or
 * a test can recognize it without hand-copying the string. */
export const PODCAST_RENDER_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: render_podcast_audio (the TTS/studio audio-rendering " +
  "pipeline, and the db::get_podcast read behind it) has no Electron port yet. " +
  "This batch ports only the job-lifecycle plumbing around it — status " +
  "transitions, the queue slot, and progress/terminal events — which is why " +
  "this call reaches a real error path rather than hanging or silently " +
  "succeeding.";

/** The stub {@link spawnPodcastAudio} falls back to when no real `render` is
 * supplied — "stub, don't fake": a clearly-labeled failure, never a fabricated
 * success. */
export const renderPodcastAudioNotImplemented: RenderPodcastAudio = () =>
  Promise.reject(new Error(PODCAST_RENDER_NOT_IMPLEMENTED));

/** {@link JobRunnerDeps} plus the one seam {@link spawnPodcastAudio} needs
 * beyond the generic runner plumbing. */
export interface SpawnPodcastAudioDeps extends JobRunnerDeps {
  render?: RenderPodcastAudio;
}

type PodcastOutcome =
  | { readonly kind: "done"; readonly fileId: string }
  | { readonly kind: "paused" }
  | { readonly kind: "error"; readonly error: string };

async function renderPodcastOutcome(
  render: RenderPodcastAudio,
  scriptFileId: string,
  cancel: CancelFlag,
): Promise<PodcastOutcome> {
  try {
    const meta = await render(scriptFileId, cancel);
    return { kind: "done", fileId: meta.id };
  } catch (err) {
    if (cancel.load()) {
      return { kind: "paused" };
    }
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

function podcastOutcomeStatus(outcome: PodcastOutcome): [string, string | null] {
  if (outcome.kind === "done") {
    return ["done", null];
  }
  if (outcome.kind === "paused") {
    return ["paused", null];
  }
  return ["error", outcome.error];
}

function savePodcastOutcome(
  deps: SpawnPodcastAudioDeps,
  jobId: string,
  roomPath: string,
  outcome: PodcastOutcome,
): void {
  const db = pinnedDb(deps.rooms, roomPath);
  if (db !== null) {
    const [status, error] = podcastOutcomeStatus(outcome);
    setJobStatus(db, jobId, status, error);
  }
}

function emitPodcastOutcome(sink: ProgressSink, jobId: string, outcome: PodcastOutcome): void {
  if (outcome.kind === "done") {
    sink.emit({ jobId, label: "Episode ready", done: 1, total: 1, finished: true, fileId: outcome.fileId });
    return;
  }
  if (outcome.kind === "paused") {
    sink.emit({ jobId, label: "Paused", done: 0, total: 1, paused: true });
    return;
  }
  sink.emit({
    jobId,
    label: `Stopped — ${outcome.error}`,
    done: 0,
    total: 1,
    failed: true,
  });
}

async function runPodcastAudio(
  deps: SpawnPodcastAudioDeps,
  jobId: string,
  roomPath: string,
  scriptFileId: string,
  cancel: CancelFlag,
  render: RenderPodcastAudio,
): Promise<void> {
  const startingDb = pinnedDb(deps.rooms, roomPath);
  if (startingDb !== null) {
    setJobStatus(startingDb, jobId, "running", null);
  }
  emitProgress(deps.sink, jobId, "Reading the script…", 0, 1);
  const outcome = await renderPodcastOutcome(render, scriptFileId, cancel);
  savePodcastOutcome(deps, jobId, roomPath, outcome);
  deps.removeCancelFlag(jobId);
  emitPodcastOutcome(deps.sink, jobId, outcome);
  await deps.onSettled(jobId);
}

/**
 * Record a podcast script as audio, in the background.
 *
 * A background job rather than a foreground call because it CANNOT be a
 * foreground call: every turn is at least one round-trip to the voice service,
 * so a twenty-turn episode is minutes of work. As a job it gets the sidebar
 * card, Stop, Resume and the auto-open the other long builds already have, and
 * the user keeps working while it records.
 *
 * A single atomic unit (`total = 1`, like the studio runner): there is no
 * mid-work checkpoint, so a Stop or a crash parks the job and resuming re-runs
 * it from scratch — a fresh recording, which is also what the user means by
 * "try again". See {@link RenderPodcastAudio} for the one dependency this batch
 * could not port.
 *
 * Returns the runner's settled promise for the same reason
 * {@link spawnJobRunner} does — a real caller fires it and moves on; tests
 * await it.
 */
export function spawnPodcastAudio(
  deps: SpawnPodcastAudioDeps,
  jobId: string,
  roomPath: string,
  scriptFileId: string,
  cancel: CancelFlag
): Promise<void> {
  const render = deps.render ?? renderPodcastAudioNotImplemented;
  return spawnJobRunner(deps, jobId, roomPath, () =>
    runPodcastAudio(deps, jobId, roomPath, scriptFileId, cancel, render));
}
