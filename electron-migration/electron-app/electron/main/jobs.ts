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
 * is the established precedent in `electron/main`, as opposed to `db-host`'s
 * throws-Error convention). This is load-bearing, not stylistic: {@link runPlan}
 * runs a wave via `Promise.all`, and a wave where step 2 of 4 REJECTS would
 * short-circuit on the first rejection — abandoning steps 0/1/3 as
 * unhandled-rejection noise instead of running all four to completion the way
 * Rust's `join_all` does (see `run_plan_discards_a_failed_waves_completed_
 * siblings`, ported from the Rust test of the same name).
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type { CancelFlag } from "./cancel.js";
import {
  type Job,
  dedupeParkedJobs,
  getJob,
  markJobParking as dbMarkJobParking,
  parkJob as dbParkJob,
  pruneJobHistory,
  setJobStatus,
  unfinishedJobs,
} from "./db-host/jobs.js";
import { finishWorkflowRunByJob, setWorkflowRunStatusByJob } from "./db-host/workflows.js";

// ============================================================================
// Lane / Step / planDispatch / runPlan — the pure, unit-tested foundation
// ============================================================================

/**
 * Where a step runs — decides how many may run at once. Local-model work is
 * serial because only one model is resident; CPU and cloud work fan out.
 * Mirrors the Rust `Lane` enum (`#[serde(rename_all = "snake_case")]`) — these
 * three strings ARE its stored wire form.
 *
 * There is deliberately NO transcription lane: speech-to-text runs entirely
 * outside the job system (`recording.rs`'s own decoder thread), so a `whisper`
 * variant would only ever cost {@link planDispatch} a slot it reserved for
 * nobody.
 */
export type Lane = "local_llm" | "cpu" | "cloud";

/** Concurrent slots per lane. Local-model work is serial (RAM and a single
 * resident model); CPU threads and remote cloud calls overlap. */
export const LANE_SLOTS: Readonly<Record<Lane, number>> = {
  local_llm: 1,
  cpu: 4,
  cloud: 4,
};

/** Every lane, for building a fresh per-lane slot table — the equivalent of
 * Rust's `for lane in [Lane::LocalLlm, Lane::Cpu, Lane::Cloud]`. */
const ALL_LANES: readonly Lane[] = ["local_llm", "cpu", "cloud"];

/** {@link LANE_SLOTS} as a function — Rust's `Lane::slots(self)`. */
export function laneSlots(lane: Lane): number {
  return LANE_SLOTS[lane];
}

/**
 * One node in a job's plan. `kind`/`params` describe the work; `dependsOn`
 * lists step ids that must finish first.
 *
 * NOT the stored shape. `lane` deliberately IS its stored wire form (Rust's
 * `Lane` is `#[serde(rename_all = "snake_case")]`), and so are `id`/`kind`/
 * `params` — but the Rust `Step` struct carries no `rename_all`, so the field
 * a real room's `jobs.plan` holds is `depends_on`, not `dependsOn`. A
 * `JSON.parse(job.plan).steps as Step[]` therefore compiles and then hands
 * {@link planDispatch} `dependsOn === undefined`, which throws inside a job
 * runner and parks the job as a crash. Whichever future batch first reads a
 * stored plan owes an explicit `depends_on` → `dependsOn` adapter at that one
 * seam; see this module's DEVIATION note.
 */
export interface Step {
  id: number;
  lane: Lane;
  kind: string;
  params: unknown;
  dependsOn: readonly number[];
}

/** The generic step-DAG envelope {@link runPlan} operates over, in its RUNTIME
 * form — see {@link Step} for why that is not byte-identical to what the `jobs`
 * row's `plan` column holds (which `db-host/jobs.ts` deliberately leaves
 * opaque). Every job kind that has steps (deep_summary, file_pass, workflow —
 * none of which this batch ports) stores a step list plus its own extra fields
 * (`auto`, `reduce`, …). Podcast audio — this batch's one concrete job kind —
 * has no steps: it is a single atomic unit, like Rust's studio and podcast
 * runners, neither of which ever calls {@link runPlan}. */
export interface Plan {
  steps: Step[];
}

/**
 * Pure scheduling decision: given the full step list, the ids already done, and
 * the ids currently running, return the steps that may start NOW —
 * dependencies satisfied and their lane still has a free slot (counting steps
 * already running plus ones chosen earlier in this same call). Deterministic:
 * lower ids win a contested slot, so runs are reproducible.
 */
export function planDispatch(
  steps: readonly Step[],
  done: ReadonlySet<number>,
  running: ReadonlySet<number>
): number[] {
  // Slots left per lane after accounting for what's already running.
  const free = new Map<Lane, number>(ALL_LANES.map((lane) => [lane, laneSlots(lane)]));
  for (const s of steps) {
    if (running.has(s.id)) {
      free.set(s.lane, Math.max(0, (free.get(s.lane) ?? 0) - 1));
    }
  }
  const chosen: number[] = [];
  for (const s of steps) {
    if (done.has(s.id) || running.has(s.id)) {
      continue;
    }
    if (!s.dependsOn.every((d) => done.has(d))) {
      continue;
    }
    const slot = free.get(s.lane) ?? 0;
    if (slot === 0) {
      continue;
    }
    free.set(s.lane, slot - 1);
    chosen.push(s.id);
  }
  return chosen;
}

/** True once every step is done — the plan is complete. */
export function planComplete(steps: readonly Step[], done: ReadonlySet<number>): boolean {
  return steps.every((s) => done.has(s.id));
}

/** Detect a plan that can never finish (a dependency cycle or a dangling
 * dependency) — nothing is running yet nothing is dispatchable. Guards the
 * scheduler against an infinite idle loop. */
export function planIsStuck(
  steps: readonly Step[],
  done: ReadonlySet<number>,
  running: ReadonlySet<number>
): boolean {
  return (
    running.size === 0 &&
    !planComplete(steps, done) &&
    planDispatch(steps, done, running).length === 0
  );
}

/**
 * Wave 4a [BLOCKER] fix, ported verbatim: the largest CONTIGUOUS done prefix —
 * the smallest id NOT in `done`. A branched multi-lane plan (a workflow) can
 * finish a wave leaving a NON-dense done-set (e.g. `{0,1,3}` while step 2 waits
 * its lane slot); storing `done.size` as the resume cursor would seed a resume
 * as `0..size`, marking step 2 done though it never ran and re-running step 3.
 * The dense prefix is always a valid `0..n` resume seed: every id below it is
 * genuinely finished, and any done-but-above-prefix step simply re-runs — which
 * is only safe because every step's side effects are idempotent (`INSERT OR
 * REPLACE` artifacts, an overwritten one-liner cache). For a single-slot serial
 * plan the prefix always equals the count.
 */
export function densePrefix(done: ReadonlySet<number>): number {
  let i = 0;
  while (done.has(i)) {
    i += 1;
  }
  return i;
}

/** A step's outcome — Rust's `Result<(), String>`. See the module doc's
 * DEVIATION note on why this is a value, not a thrown exception. */
export type StepResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Maps a step to real work — the piece `run_plan` is generic over in Rust (its
 * `execute: F where F: FnMut(Step) -> Fut<Result<(), String>>` parameter).
 * Every job kind that has steps supplies its own (`deep_summary`'s per-file
 * one-liner call, `file_pass`'s per-window model call, …), none of which this
 * batch ports. */
export type ExecuteStep = (step: Step) => Promise<StepResult>;

/** How a plan run ended. */
export type RunOutcome =
  | { readonly kind: "done" }
  /** Cancel flag was set — the job is checkpointed and resumable. */
  | { readonly kind: "paused" }
  /** A step failed (its error) — the job is parked resumable. */
  | { readonly kind: "error"; readonly error: string };

/** The minimal `AtomicBool`-alike {@link runPlan} needs to observe a Stop.
 * `cancel.ts`'s {@link CancelFlag} satisfies this structurally, and so does any
 * test double with a bare `load()`. */
export interface CancelSignal {
  load(): boolean;
}

/**
 * Drive a plan to completion. Plans are built in dependency order (a step's
 * deps always have lower ids). Each wave dispatches every ready step its lanes
 * allow, runs them concurrently, then `checkpoint(done)` persists progress and
 * `progress(done, total)` updates the UI. A set `cancel` flag pauses between
 * waves; a step error parks the job. Generic over `execute` so it is unit-
 * tested without a database or a model.
 *
 * `startDone` is the actual set of finished step ids (seeded `0..cursor` for
 * the serial job kinds, an arbitrary persisted set for a branched workflow),
 * and `checkpoint` receives the whole done SET — not a scalar count — so a
 * workflow spawner can serialize the real done-set for a correct resume, while
 * a serial spawner keeps storing {@link densePrefix} of it.
 *
 * A wave is the unit of durability: `Promise.all` drives every step in it (like
 * Rust's `join_all`), but the first failure returns BEFORE `checkpoint` is
 * called, so a failed wave's succeeded siblings are not persisted and re-run on
 * resume. That is what keeps "done stays a valid prefix" true on a fan-out
 * lane.
 *
 * DEVIATION (from the Rust source's own shape, not a behaviour change):
 * `plan_dispatch` returns step IDs and `run_plan` then indexes `steps[id]`,
 * which is correct only because every plan builder assigns `id = index`. This
 * port resolves the id through a map built from `steps` itself, so a plan whose
 * ids are not their indices runs the step it named rather than silently running
 * a different one. Identical behaviour whenever the invariant holds.
 */
export async function runPlan(
  steps: readonly Step[],
  startDone: ReadonlySet<number>,
  cancel: CancelSignal,
  execute: ExecuteStep,
  checkpoint: (done: ReadonlySet<number>) => void,
  progress: (done: number, total: number) => void
): Promise<RunOutcome> {
  const total = steps.length;
  const byId = new Map<number, Step>(steps.map((s) => [s.id, s]));
  const done = new Set<number>(startDone);
  progress(done.size, total);

  // `run_plan` awaits each wave fully before starting the next, so from this
  // driver's point of view nothing is ever "still running" — Rust passes an
  // always-empty `running` set to both calls below, and so does this.
  const empty: ReadonlySet<number> = new Set();

  while (!planComplete(steps, done)) {
    if (cancel.load()) {
      return { kind: "paused" };
    }
    if (planIsStuck(steps, done, empty)) {
      return { kind: "error", error: "job plan cannot make progress" };
    }
    const wave = planDispatch(steps, done, empty);
    const results = await Promise.all(wave.map((id) => execute(byId.get(id) as Step)));
    for (let i = 0; i < wave.length; i++) {
      const result = results[i] as StepResult;
      if (!result.ok) {
        return { kind: "error", error: result.error };
      }
      done.add(wave[i] as number);
    }
    checkpoint(done);
    progress(done.size, total);
  }
  return { kind: "done" };
}

// ============================================================================
// progress events / the room pin
// ============================================================================

/** The `job-progress` event payload — the union of every field ANY runner in
 * `jobs.rs` sends through its `serde_json::json!({...})` literals; a given
 * event sets only the ones relevant to it, exactly as those macros do. */
export interface JobProgressPayload {
  jobId: string;
  label: string;
  done: number;
  total: number;
  finished?: boolean;
  paused?: boolean;
  failed?: boolean;
  fileId?: string | null;
}

/** Where `job-progress` events go — Rust's `window.emit("job-progress", …)`.
 * No Electron `BrowserWindow` wiring exists in this rewrite yet; a future
 * batch's implementation is a thin `webContents.send("job-progress", payload)`
 * adapter (or a one-line bridge to `turn.ts`'s existing `EventSender`), and
 * tests use a recording stub. */
export interface ProgressSink {
  emit(payload: JobProgressPayload): void;
}

/** Emit the job's live progress. `label` is human ("Reading part 4 of 17");
 * `done`/`total` drive the bar. */
export function emitProgress(
  sink: ProgressSink,
  jobId: string,
  label: string,
  done: number,
  total: number
): void {
  sink.emit({ jobId, label, done, total });
}

/** One open room, as much of it as this batch's runners need. */
export interface RoomHandle {
  db: Database.Database;
  path: string;
}

/**
 * Minimal stand-in for `tauri::State<'_, AppState>`'s room access, scoped to
 * exactly what `jobs.rs`'s runners use it for: reading the CURRENTLY open room
 * so a write can be pinned to the room the job started in ("a room closed or
 * swapped mid-run can never receive this job's writes" — every runner in the
 * Rust source re-checks `room.path == room_path` before every read/write).
 */
export interface RoomSource {
  /** The open room, or `null` if none is open. */
  current(): RoomHandle | null;
}

/** `room.db` only if the room currently open is STILL the one this job started
 * in — the room-pin discipline every runner in `jobs.rs` applies by hand before
 * every read/write (`guard.as_ref().filter(|r| r.path == room_path)`). */
export function pinnedDb(rooms: RoomSource, roomPath: string): Database.Database | null {
  const room = rooms.current();
  return room !== null && room.path === roomPath ? room.db : null;
}

// ============================================================================
// Job-lifecycle housekeeping — DB-only, no AppState/Window needed
// ============================================================================

/** Why a job stopped when the room was LOCKED (or swapped) under it. The user
 * caused this, but not by pressing Stop, so the card must not read like a pause
 * they chose — "Resume" on a job they never paused is a small lie about who
 * stopped it and why the work is unfinished. */
export const PARKED_BY_LOCK = "The room was locked while this was still running.";

/** Why a job stopped when the APP went away — a quit, a crash, a forced
 * restart. Detected at the next unlock, because nothing ran at exit to say
 * it. */
export const PARKED_BY_EXIT = "The app closed while this was still running.";

/**
 * Stamp the parking reason on every live top-level job, WITHOUT stopping any of
 * them. Called from the lock/close drain while the room is still open and the
 * runners are still alive, so whichever way each runner lands a moment later
 * the row can already say what interrupted it. Returns how many rows were
 * stamped.
 *
 * 'running' ONLY. A queued row is never parked by the app —
 * {@link parkRunningJobs} and {@link quiesceStaleJobs} both skip it so the
 * queue pump can auto-start it — and if the pump promotes one to 'running'
 * during the drain, `parkJob` writes the reason itself. So stamping a queued
 * row can never come true, and it does come back to bite: the only way a queued
 * row reaches 'paused' is the user pressing Remove, and `setJobStatus(..,
 * "paused")` deliberately PRESERVES the reason (the running runner's epilogue
 * depends on that), so the card would blame the lock for a removal the user
 * chose, on work that never started.
 */
export function markJobsParking(db: Database.Database, reason: string): number {
  let jobs: Job[];
  try {
    jobs = unfinishedJobs(db);
  } catch {
    return 0;
  }
  let count = 0;
  for (const j of jobs) {
    if (j.status !== "running") {
      continue;
    }
    try {
      dbMarkJobParking(db, j.id, reason);
      count += 1;
    } catch {
      // A write that failed did not stamp a row, so it is not counted.
    }
  }
  return count;
}

/**
 * Park every job still reading as 'running' — the runner is gone, or is about
 * to lose the room it writes to. Returns how many were parked.
 *
 * 'queued' is deliberately left alone: a queued job never started, holds no
 * half-finished work, and the pump auto-resumes it at the next unlock.
 * Demoting it here is exactly the change that once made `pump_on_open` a dead
 * no-op.
 */
export function parkRunningJobs(db: Database.Database, reason: string): number {
  let jobs: Job[];
  try {
    jobs = unfinishedJobs(db);
  } catch {
    return 0;
  }
  let parked = 0;
  for (const j of jobs) {
    if (j.status !== "running") {
      continue;
    }
    try {
      dbParkJob(db, j.id, reason);
    } catch {
      continue;
    }
    // A workflow's run row must stop reading as 'running' too, or its history
    // line keeps a live green dot for a job that is parked. Harmless (a no-op
    // UPDATE) for the other job kinds — they have no run row.
    try {
      setWorkflowRunStatusByJob(db, j.id, "paused");
    } catch {
      // best-effort, mirrors the Rust `let _ = ...`
    }
    parked += 1;
  }
  return parked;
}

/**
 * On room open, any job left 'running' belongs to a process that's gone — park
 * those 'paused' so the UI offers Resume instead of a phantom active card. The
 * lock path parks its own jobs before the room handle drops, so what reaches
 * here still reading 'running' is work the app never got to say goodbye to: a
 * quit, a crash, a kill. Naming that is the whole point — "Paused" alone
 * described a deliberate Stop the user never made.
 */
export function quiesceStaleJobs(db: Database.Database): void {
  parkRunningJobs(db, PARKED_BY_EXIT);
  // Those rows became parked JUST NOW — after migrate()'s duplicate sweep had
  // already run (open_room migrates, then quiesces). A workflow still 'running'
  // when the app died is exactly the row that superseded the parked attempt
  // beside it, so without this the user opens the room and still sees two
  // indistinguishable cards for one workflow. Sweeping again here costs one
  // scan of a handful of rows and is a no-op on a room that is already clean.
  try {
    dedupeParkedJobs(db);
  } catch {
    // best-effort, mirrors the Rust `let _ = ...`
  }
  // And roll the finished history off the back. Nothing else ever removed a
  // 'done' job, its artifacts or a closed run row, so an interval-scheduled
  // workflow grew the encrypted room file without bound. Room open is the one
  // moment the connection is held with no runner attached to any row.
  try {
    pruneJobHistory(db);
  } catch {
    // best-effort, mirrors the Rust `let _ = ...`
  }
}

/**
 * Park a job whose runner died without reaching its own epilogue.
 *
 * Returns the row's `{cursor, total}` when it actually parked something, and
 * `null` when the row was already off the live statuses — a failure caught in
 * the epilogue AFTER the terminal write must not rewrite a real 'done' as a
 * failure, and a 'paused' row is already resumable and already honest. Only
 * 'running' and 'queued' still read as live work, so only those are parked.
 *
 * Throws (via `getJob`) if the row itself is unreadable, exactly where Rust's
 * `?` propagates: there is nothing to park, so nothing is reported parked.
 */
export function parkCrashedJob(
  db: Database.Database,
  jobId: string,
  reason: string
): { cursor: number; total: number } | null {
  const job = getJob(db, jobId);
  if (job.status !== "running" && job.status !== "queued") {
    return null;
  }
  setJobStatus(db, jobId, "error", reason);
  // A workflow job also owns a `workflow_runs` row; the other kinds have none
  // and this is a no-op for them (same reasoning as `quiesceStaleJobs`).
  try {
    finishWorkflowRunByJob(db, jobId, "error", reason);
  } catch {
    // best-effort, mirrors the Rust `let _ = ...`
  }
  return { cursor: job.cursor, total: job.total };
}

// ============================================================================
// crashReason / spawnJobRunner — panic_reason / spawn_job_runner
// ============================================================================

/**
 * A caught failure as a sentence fit for a job's `error` column. Ported from
 * `panic_reason`: `catch_unwind`'s payload is `Box<dyn Any>`, of which only the
 * `&str`/`String` cases carry a message; the JS equivalent is a caught value of
 * unknown shape, at least as likely to already BE an `Error`. Either way the
 * fallback must still say a CRASH happened rather than leaving the column blank
 * for the Sidebar to render as "Stopped — " explaining nothing.
 */
export function crashReason(err: unknown): string {
  const detail =
    err instanceof Error && err.message.trim() !== ""
      ? err.message
      : typeof err === "string" && err.trim() !== ""
        ? err
        : null;
  return detail !== null ? `the job runner crashed: ${detail}` : "the job runner crashed";
}

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
  return (async () => {
    try {
      await body(); // the body ran its own epilogue
      return;
    } catch (err) {
      const reason = crashReason(err);
      // Mirrors the Rust source's own `eprintln!` — the host has no log sink
      // injected here, and a silent crash is the failure mode being fixed.
      console.error(`job ${jobId} runner crashed: ${reason}`);
      const db = pinnedDb(deps.rooms, roomPath);
      let parked: { cursor: number; total: number } | null = null;
      if (db !== null) {
        try {
          parked = parkCrashedJob(db, jobId, reason);
        } catch {
          parked = null;
        }
      }
      try {
        deps.removeCancelFlag(jobId);
      } catch {
        // Nothing above this handler is left to catch a failure here, and the
        // queue must still be pumped.
      }
      if (parked !== null) {
        // Report the row's OWN checkpointed numbers — a crash knows how far the
        // job got only from what it managed to persist, and inventing 0/0 would
        // wipe a progress bar that had honestly advanced.
        try {
          deps.sink.emit({
            jobId,
            label: `Stopped — ${reason}`,
            done: parked.cursor,
            total: parked.total,
            failed: true,
          });
        } catch {
          // ditto — a broken renderer channel must not cost the queue its slot.
        }
      }
      try {
        await deps.onSettled(jobId);
      } catch {
        // The last statement of the last handler: rethrowing here would be an
        // unhandled rejection nobody can observe, which is what this whole
        // wrapper exists to prevent.
      }
    }
  })();
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
  return spawnJobRunner(deps, jobId, roomPath, async () => {
    const startingDb = pinnedDb(deps.rooms, roomPath);
    if (startingDb !== null) {
      setJobStatus(startingDb, jobId, "running", null);
    }
    emitProgress(deps.sink, jobId, "Reading the script…", 0, 1);

    // done(fileId) = the episode exists; paused = a Stop; error = a real
    // failure to explain. `RunOutcome`'s own `done` carries no file, so this
    // runner has its own three-way answer rather than reusing it.
    let outcome:
      | { readonly kind: "done"; readonly fileId: string }
      | { readonly kind: "paused" }
      | { readonly kind: "error"; readonly error: string };
    try {
      const meta = await render(scriptFileId, cancel);
      outcome = { kind: "done", fileId: meta.id };
    } catch (err) {
      // Same convention as the studio runner: any error while the cancel flag
      // is set is a clean Pause, not a failure to explain.
      outcome = cancel.load()
        ? { kind: "paused" }
        : { kind: "error", error: err instanceof Error ? err.message : String(err) };
    }

    const finishingDb = pinnedDb(deps.rooms, roomPath);
    if (finishingDb !== null) {
      const [status, error]: [string, string | null] =
        outcome.kind === "done"
          ? ["done", null]
          : outcome.kind === "paused"
            ? ["paused", null]
            : ["error", outcome.error];
      setJobStatus(finishingDb, jobId, status, error);
    }
    deps.removeCancelFlag(jobId);

    if (outcome.kind === "done") {
      deps.sink.emit({
        jobId,
        label: "Episode ready",
        done: 1,
        total: 1,
        finished: true,
        fileId: outcome.fileId,
      });
    } else if (outcome.kind === "paused") {
      deps.sink.emit({ jobId, label: "Paused", done: 0, total: 1, paused: true });
    } else {
      deps.sink.emit({
        jobId,
        label: `Stopped — ${outcome.error}`,
        done: 0,
        total: 1,
        failed: true,
      });
    }
    await deps.onSettled(jobId);
  });
}
