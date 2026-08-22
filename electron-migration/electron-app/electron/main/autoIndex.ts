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
import type { RoomSource } from "./jobs.js";

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
/** Drops of at most this many missing files stay silent (quiet filler, no
 * job-card noise); anything larger becomes a visible job. */
export const QUIET_FILLER_MAX = 5;

// ============================================================================
// The pure policy — auto_index_decision
// ============================================================================

/**
 * What the scheduler should do once the debounce elapses — the TS spelling of
 * Rust's `AutoIndexDecision` (`Skip`/`QuietFiller`/`StartJob`/`Retry`), in the
 * camelCase tag convention this codebase's other ported unions already use
 * (`mcpConfig.ts`'s `needsApproval`, `editMatchFuzzy.ts`'s `notFound`).
 */
export type AutoIndexDecision = "skip" | "quietFiller" | "startJob" | "retry";

/**
 * `settingOn`: the `auto_index` room setting (absent = on, `"0"` = off).
 * `missing`: `filesMissingSummary` count (sentinel'd files excluded).
 * `jobRunning` / `asking`: live cancel-registry probes.
 * `modelsAvailable`: whether Ollama reported any installed model.
 *
 * Pure — this is where the whole policy lives, so it is unit-tested
 * exhaustively with the Rust suite's own table.
 */
export function autoIndexDecision(
  settingOn: boolean,
  missing: number,
  jobRunning: boolean,
  asking: boolean,
  modelsAvailable: boolean
): AutoIndexDecision {
  if (!settingOn) {
    // Off means off. This returned QuietFiller — introduced as "byte-for-byte
    // today's behavior" so adding the toggle changed nothing — with the result
    // that the switch labelled "Describe new files automatically with the
    // local AI" went on describing new files automatically with the local AI.
    // A setting that does not do what it says is worse than no setting, and
    // this one also spends the room's single model lane behind the back of
    // someone who asked for it not to be.
    return "skip";
  }
  if (asking || jobRunning) {
    return "retry";
  }
  if (!modelsAvailable || missing === 0) {
    return "skip";
  }
  return missing <= QUIET_FILLER_MAX ? "quietFiller" : "startJob";
}

// ============================================================================
// The three unported actions — injectable seams, "stub, don't fake"
// ============================================================================

/**
 * `start_deep_summary_inner(window, state, auto = true)` — build the
 * missing-file plan, resolve the engine/model, create the durable job row and
 * spawn the per-file summarizer runner. Resolves to the new job id; rejects on
 * a genuine refusal (queue at capacity, nothing left to index, a mid-rollback
 * room). This module is the `auto = true` call site, its only one, so the flag
 * is baked in rather than passed.
 */
export type StartDeepSummaryAuto = (roomPath: string) => Promise<string>;

/** The labeled reason the stubbed deep-summary starter fails with. Exported so
 * a caller or a test can recognize it without hand-copying the string —
 * `jobs.ts`'s `PODCAST_RENDER_NOT_IMPLEMENTED` convention. */
export const START_DEEP_SUMMARY_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: start_deep_summary_inner (the deep-summary plan builder, " +
  "engine resolution and per-file summarizer runner, in " +
  "src-tauri/src/commands/jobs.rs) has no Electron port yet — this batch " +
  "ports only the auto-index scheduler that decides when to call it.";

/** The stub to wire into {@link AutoIndexDeps} until a real
 * {@link StartDeepSummaryAuto} exists (the field is required — nothing falls
 * back to this on its own): a clearly-labeled failure, never a
 * fabricated success. Rust's own `let _ = start_deep_summary_inner(...).await;`
 * already discards the result, so a rejection here reaches exactly the path a
 * real refusal would. */
export const startDeepSummaryAutoNotImplemented: StartDeepSummaryAuto = () =>
  Promise.reject(new Error(START_DEEP_SUMMARY_NOT_IMPLEMENTED));

/**
 * `start_rec_read(window, state, roomPath, fileId)` — build the read plan for
 * one recording (partition its transcript, resolve the pass engine) and spawn
 * the reading-pass runner. Resolves to the new job id; rejects when reading
 * would be dishonest rather than merely unhelpful (no transcript yet, already
 * being read) or the queue refuses.
 */
export type StartRecRead = (roomPath: string, fileId: string) => Promise<string>;

/** The labeled reason the stubbed recording-read starter fails with. */
export const START_REC_READ_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: start_rec_read (the reading-pass plan builder and runner, " +
  "in src-tauri/src/commands/jobs/rec_read.rs) has no Electron port yet — " +
  "this batch ports only the scheduler that decides a recording is due for one.";

/** The stub to wire into {@link AutoIndexDeps} until a real
 * {@link StartRecRead} exists (the field is required — nothing falls back to
 * this on its own). A rejection is read EXACTLY like a real
 * refusal: the tick falls through to the ordinary summary decision, precisely
 * as Rust's `if start_rec_read(...).await.is_ok() { return; }` does with any
 * `Err`. */
export const startRecReadNotImplemented: StartRecRead = () =>
  Promise.reject(new Error(START_REC_READ_NOT_IMPLEMENTED));

/** `spawn_summary_filler(app, roomPath, delaySecs)` — the legacy,
 * single-flight, non-durable opportunistic filler. Fire-and-forget in Rust too
 * (it returns nothing, and "all failures are silent" is its own doc), so this
 * seam is `void` as well. `delaySecs` is load-bearing and always 0 from here:
 * this waiter has ALREADY debounced, so the filler's own head start would
 * otherwise stack on top. */
export type SpawnSummaryFiller = (roomPath: string, delaySecs: number) => void;

/** The labeled reason the stubbed quiet filler reports. */
export const SUMMARY_FILLER_NOT_IMPLEMENTED =
  "NOT_IMPLEMENTED: spawn_summary_filler (the legacy opportunistic one-liner " +
  "filler, in src-tauri/src/commands/stt_cmds.rs) has no Electron port yet — " +
  "this tick would have started it for a small drop.";

/** The stub to wire into {@link AutoIndexDeps} until a real
 * {@link SpawnSummaryFiller} exists (the field is required — nothing falls back
 * to this on its own). Logs rather than throwing: the Rust
 * call it stands in for is `void`, and a scheduler tick must not fail because
 * the filler beneath it is unbuilt. It does not stay SILENT either — a silent
 * no-op is indistinguishable from a production wiring that forgot to pass the
 * real filler in. */
export const spawnSummaryFillerNotImplemented: SpawnSummaryFiller = () => {
  console.error(SUMMARY_FILLER_NOT_IMPLEMENTED);
};

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
  const room = rooms.current();
  if (room === null || room.path !== roomPath) {
    return;
  }
  let jobs: Job[];
  try {
    jobs = unfinishedJobs(room.db);
  } catch {
    return; // mirrors the `?` inside Rust's swallowed `let _ = with_room(...)`
  }
  for (const j of jobs) {
    if (j.kind === "deep_summary" && isRecord(j.plan) && j.plan["auto"] === true) {
      try {
        deleteJob(room.db, j.id);
      } catch {
        // best-effort, mirrors Rust's `let _ = db::delete_job(...)`.
      }
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
  const mine = (): boolean => state.generation === generation;
  const listModels = deps.listModels ?? listModelsReal;

  // A later ingest re-armed the debounce — that waiter owns the run.
  if (!mine()) {
    return { kind: "stale" };
  }

  const room = readRoomState(deps.rooms, roomPath);
  if (room === null) {
    return { kind: "stale" };
  }
  const { settingOn, missing } = room;

  const asking = deps.cancelState.cancels.size > 0;
  const jobRunning = deps.cancelState.jobCancels.size > 0;

  const modelsAvailable = (await listModels()).length > 0;
  // The model probe awaited — a newer waiter may own the run now.
  if (!mine()) {
    return { kind: "stale" };
  }

  // The room reads recordings it has never read, on the same tick as the
  // summary sweep — same debounce, same busy probes, same model probe (see
  // this module's doc for why this is not a second scheduler). `settingOn`
  // gates this arm too: reading a recording the room has never read IS
  // describing a new file with the local AI, exactly what the switch says it
  // controls, so leaving it out meant the box could be off while the same tick
  // still spent the room's one model lane. Half a switch is the same defect as
  // no switch, only harder to notice.
  if (settingOn && modelsAvailable && !jobRunning && !asking) {
    const fileId = nextUnreadRecording(deps.rooms, roomPath);
    if (fileId !== undefined) {
      // Only a read that actually STARTED has spent this tick's model lane and
      // earned the early exit. One that could not start — room at job
      // capacity, this recording already queued, no transcript yet — spends
      // nothing, and returning on it starved the summary sweep below for as
      // long as the recording stayed unread: every import after it went
      // undescribed, on this tick and on every later one.
      let started = false;
      try {
        await deps.startRecRead(roomPath, fileId);
        started = true;
      } catch {
        started = false;
      }
      if (started) {
        return { kind: "recRead", fileId };
      }
      // That attempt awaited (it resolves the pass engine before it can refuse
      // for a full queue), so the same rule as the model probe applies to the
      // sweep it now falls through to.
      if (!mine()) {
        return { kind: "stale" };
      }
    }
  }

  switch (autoIndexDecision(settingOn, missing, jobRunning, asking, modelsAvailable)) {
    case "skip":
      return { kind: "skip" };
    case "quietFiller":
      // Delay 0: this waiter already debounced (addendum fix — the filler's
      // own 45 s head start would otherwise stack on top).
      deps.spawnSummaryFiller(roomPath, 0);
      return { kind: "quietFiller" };
    case "retry":
      return { kind: "retry" };
    case "startJob": {
      retireUnfinishedAutoDeepSummaryJobs(deps.rooms, roomPath);
      if (deps.rooms.current() === null) {
        return { kind: "stale" }; // folded main_window check — see module doc
      }
      let jobId: string | null = null;
      try {
        jobId = await deps.startDeepSummaryAuto(roomPath);
      } catch {
        jobId = null; // matches Rust's `let _ = start_deep_summary_inner(...)`
      }
      return { kind: "startJob", jobId };
    }
  }
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
