/**
 * Vitest port of `commands/jobs.rs`'s pure and DB-only test coverage — see
 * `jobs.ts`'s module doc for exactly what is (and is not) ported.
 *
 * Ported from the Rust `#[cfg(test)] mod tests` in `commands/jobs.rs`:
 *   - local_lane_is_serial
 *   - cloud_lane_fans_out_to_its_slot_count
 *   - different_lanes_run_in_parallel
 *   - dependencies_gate_dispatch
 *   - completion_and_stuck_detection
 *   - dense_prefix_is_smallest_missing_id
 *   - run_plan_checkpoints_dense_prefix_not_count_on_branched_plan
 *   - run_plan_runs_deps_before_dependents_and_checkpoints
 *   - run_plan_pauses_on_cancel_and_is_resumable
 *   - cancel_during_final_wave_still_returns_done
 *   - run_plan_parks_on_step_error
 *   - run_plan_checkpoints_once_per_wave_not_once_per_step
 *   - run_plan_discards_a_failed_waves_completed_siblings
 *   - run_plan_honors_a_real_done_set_but_a_prefix_seed_replays
 *   - run_plan_cancelled_before_the_first_wave_is_a_no_op
 *   - a_fully_cached_resume_is_done_with_no_work_and_no_checkpoint
 *   - a_panic_with_no_message_still_reports_a_crash (→ crashReason)
 *   - quiesce_parks_running_jobs_keeps_queued_and_preserves_the_checkpoint
 *   - quiesce_collapses_the_duplicate_it_just_created
 *   - a_job_running_when_the_room_locks_is_parked_and_says_the_lock_did_it
 *   - a_runner_that_stops_in_time_during_the_lock_still_reads_as_parked
 *   - a_job_that_finishes_inside_the_lock_drain_is_not_called_parked
 *   - a_parked_job_resumes_from_its_checkpoint_and_drops_the_explanation
 *   - a_job_the_user_stopped_is_never_blamed_on_the_app
 *   - removing_a_job_from_the_queue_after_a_lock_is_not_blamed_on_the_lock
 *   - a_job_the_app_died_on_is_parked_at_the_next_unlock_and_named_as_such
 *   - a_crashed_runner_leaves_every_live_row_terminal_and_says_why
 *   - a_crash_after_the_epilogue_never_rewrites_a_finished_job
 *
 * Plus coverage this port adds where the Rust source has no unit-testable
 * equivalent (its runners need the full Tauri `AppState`/`Window`): a lane at
 * capacity, a step whose dependency failed, {@link spawnJobRunner}'s crash
 * safety and room pin, and {@link spawnPodcastAudio}'s four landings.
 *
 * NOT ported: `file_pass_*` / `the_resume_gate_hashes_the_smart_filtered_text_
 * not_the_file` / `deep_summary_lane_choice_sets_the_checkpoint_granularity`
 * (they depend on `build_pass_steps` / `extraction::smart_filter` /
 * `runs_on_this_mac`), `the_summary_progress_card_names_the_file_being_read` /
 * `the_manual_resume_cursor_stops_at_the_first_uncached_file` /
 * `a_failed_call_is_not_a_file_that_cannot_be_described` /
 * `deep_summary_stored_cursor_is_write_only_and_can_disagree_with_the_cache`
 * (all pin `spawn_deep_summary`-only helpers) — every one of them out of scope
 * per `jobs.ts`'s module doc.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { CancelFlag } from "./cancel.js";
import { createRoom } from "./db-host/open.js";
import {
  checkpointJob,
  createChildJob,
  createJob,
  getJob,
  listJobs,
  setJobStatus,
  unfinishedJobs,
} from "./db-host/jobs.js";
import {
  type CancelSignal,
  crashReason,
  densePrefix,
  type JobProgressPayload,
  type JobRunnerDeps,
  type Lane,
  laneSlots,
  markJobsParking,
  PARKED_BY_EXIT,
  PARKED_BY_LOCK,
  parkCrashedJob,
  parkRunningJobs,
  planComplete,
  planDispatch,
  planIsStuck,
  PODCAST_RENDER_NOT_IMPLEMENTED,
  type ProgressSink,
  quiesceStaleJobs,
  type RenderPodcastAudio,
  type RoomHandle,
  type RoomSource,
  renderPodcastAudioNotImplemented,
  type RunOutcome,
  runPlan,
  spawnJobRunner,
  spawnPodcastAudio,
  type Step,
} from "./jobs.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "jobs-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
}

function step(id: number, lane: Lane, deps: readonly number[] = []): Step {
  return { id, lane, kind: "noop", params: null, dependsOn: deps };
}

function set(...xs: number[]): Set<number> {
  return new Set(xs);
}

/** The successful step outcome, matching the Rust tests' bare `Ok(())`. */
const ok = { ok: true } as const;

/** A cancel flag that is never set — the Rust tests'
 * `Arc::new(AtomicBool::new(false))`. */
const never: CancelSignal = { load: () => false };

// ============================================================================
// planDispatch — the pure scheduling decision everything else rests on
// ============================================================================

describe("planDispatch", () => {
  it("local_lane_is_serial", () => {
    // Three independent local-model steps: only ONE may start at a time.
    const steps = [step(0, "local_llm"), step(1, "local_llm"), step(2, "local_llm")];
    expect(planDispatch(steps, set(), set()), "lowest id wins the single slot").toEqual([0]);
    // With step 0 running, nothing else can start on the local lane.
    expect(planDispatch(steps, set(), set(0))).toEqual([]);
  });

  it("cloud_lane_fans_out_to_its_slot_count", () => {
    // Five independent cloud steps, 4 slots → 4 dispatched at once.
    const steps = [0, 1, 2, 3, 4].map((i) => step(i, "cloud"));
    expect(planDispatch(steps, set(), set())).toEqual([0, 1, 2, 3]);
  });

  it("different_lanes_run_in_parallel", () => {
    // A CPU decode, a cloud call and a local digest are all ready and on
    // different lanes → all three start together.
    const steps = [step(0, "cpu"), step(1, "cloud"), step(2, "local_llm")];
    expect(planDispatch(steps, set(), set())).toEqual([0, 1, 2]);
  });

  it("dependencies_gate_dispatch", () => {
    // reduce(2) waits for digests 0 and 1.
    const steps = [step(0, "cloud"), step(1, "cloud"), step(2, "local_llm", [0, 1])];
    expect(planDispatch(steps, set(), set()), "only 0 and 1 are ready").toEqual([0, 1]);
    // With 0 done but 1 still running, reduce still can't start.
    expect(planDispatch(steps, set(0), set(1))).toEqual([]);
    // Both deps done → reduce is dispatchable.
    expect(planDispatch(steps, set(0, 1), set())).toEqual([2]);
  });

  it("counts running steps against their own lane, and only their own lane", () => {
    // The half of the decision the Rust fixtures only touch obliquely: the
    // running set decrements the lane's free slots BEFORE anything is chosen,
    // and a lane at capacity blocks its own steps while every other lane is
    // untouched.
    expect(laneSlots("local_llm")).toBe(1);
    expect(laneSlots("cpu")).toBe(4);
    expect(laneSlots("cloud")).toBe(4);

    const cpu = [0, 1, 2, 3, 4].map((i) => step(i, "cpu"));
    expect(planDispatch(cpu, set(), set(0, 1, 2, 3)), "all four CPU slots taken").toEqual([]);
    expect(
      planDispatch(cpu, set(), set(0, 1, 2)),
      "one slot left, and the lowest id that is not already running takes it"
    ).toEqual([3]);

    const mixed = [step(0, "cpu"), step(1, "cpu"), step(2, "cpu"), step(3, "cpu"), step(4, "cpu"), step(5, "cloud")];
    expect(
      planDispatch(mixed, set(), set(0, 1, 2, 3)),
      "a saturated CPU lane never blocks the cloud lane"
    ).toEqual([5]);
  });

  it("a done step neither runs again nor holds a slot", () => {
    const steps = [step(0, "local_llm"), step(1, "local_llm")];
    expect(planDispatch(steps, set(0), set())).toEqual([1]);
    expect(planDispatch(steps, set(0, 1), set())).toEqual([]);
  });
});

describe("planComplete / planIsStuck", () => {
  it("completion_and_stuck_detection", () => {
    const steps = [step(0, "cpu"), step(1, "cpu", [0])];
    expect(planComplete(steps, set())).toBe(false);
    expect(planComplete(steps, set(0, 1))).toBe(true);
    // A dangling dependency (step 1 needs a nonexistent step 9) is stuck.
    const broken = [step(0, "cpu"), step(1, "cpu", [9])];
    expect(planIsStuck(broken, set(0), set())).toBe(true);
    // A healthy plan mid-run is NOT stuck.
    expect(planIsStuck(steps, set(), set(0))).toBe(false);
  });
});

describe("densePrefix", () => {
  it("dense_prefix_is_smallest_missing_id", () => {
    expect(densePrefix(set())).toBe(0);
    expect(densePrefix(set(0, 1, 2))).toBe(3);
    // {0,1,3}: step 2 is a hole, so the valid resume prefix is 2 (NOT 3).
    expect(densePrefix(set(0, 1, 3))).toBe(2);
    // A set missing 0 entirely resumes from scratch.
    expect(densePrefix(set(1, 2, 3))).toBe(0);
  });
});

// ============================================================================
// runPlan
// ============================================================================

describe("runPlan", () => {
  it("run_plan_checkpoints_dense_prefix_not_count_on_branched_plan", async () => {
    // To exercise a NON-dense done-set the contention must be SAME-lane.
    // LocalLlm concurrency is 1, so with two LocalLlm steps (1,2) both ready
    // after 0, only one runs per wave while the Cpu step (3) runs alongside — a
    // wave finishes {0,1,3} with id 2 still pending. densePrefix there is 2,
    // but done.size is 3. The checkpoint MUST record the prefix: recording 3
    // would mark id 2 done though it never ran.
    const steps = [
      step(0, "local_llm"),
      step(1, "local_llm", [0]),
      step(2, "local_llm", [0]),
      step(3, "cpu", [0]),
    ];
    const seen: Array<[number, number]> = [];
    const outcome = await runPlan(
      steps,
      set(),
      never,
      async () => ok,
      (done) => seen.push([densePrefix(done), done.size]),
      () => {}
    );
    expect(outcome).toEqual<RunOutcome>({ kind: "done" });
    expect(
      seen.some(([prefix, count]) => prefix < count),
      `expected a non-dense checkpoint (prefix < count); saw ${JSON.stringify(seen)}`
    ).toBe(true);
    // Every recorded prefix is a valid contiguous resume point, ending full.
    expect(seen.every(([prefix]) => prefix <= 4)).toBe(true);
    expect(seen[seen.length - 1]?.[0]).toBe(4);
  });

  it("run_plan_runs_deps_before_dependents_and_checkpoints", async () => {
    // digest 0,1,2 (cloud) → reduce 3 (local). Record execution order.
    const steps = [step(0, "cloud"), step(1, "cloud"), step(2, "cloud"), step(3, "local_llm", [0, 1, 2])];
    const order: number[] = [];
    const checkpoints: number[] = [];
    const outcome = await runPlan(
      steps,
      set(),
      never,
      async (s) => {
        order.push(s.id);
        return ok;
      },
      (done) => checkpoints.push(done.size),
      () => {}
    );
    expect(outcome).toEqual<RunOutcome>({ kind: "done" });
    expect(order[order.length - 1], "reduce runs only after all digests").toBe(3);
    expect(order.slice(0, 3).sort()).toEqual([0, 1, 2]);
    expect(checkpoints[checkpoints.length - 1]).toBe(4);
  });

  it("run_plan_pauses_on_cancel_and_is_resumable", async () => {
    const steps = [0, 1, 2, 3].map((i) => step(i, "local_llm"));
    const cancel = new CancelFlag();
    let ran = 0;
    let lastCursor = 0;
    const outcome = await runPlan(
      steps,
      set(),
      cancel,
      async () => {
        ran += 1;
        if (ran === 2) {
          cancel.store(true); // trip cancel after the second step completes
        }
        return ok;
      },
      (done) => {
        lastCursor = densePrefix(done);
      },
      () => {}
    );
    expect(outcome).toEqual<RunOutcome>({ kind: "paused" });
    expect(ran, "serial lane ran exactly two before pausing").toBe(2);
    expect(lastCursor).toBe(2);

    // Resume from cursor 2: only the remaining two steps run.
    const resumed: number[] = [];
    const outcome2 = await runPlan(
      steps,
      set(0, 1),
      never,
      async (s) => {
        resumed.push(s.id);
        return ok;
      },
      () => {},
      () => {}
    );
    expect(outcome2).toEqual<RunOutcome>({ kind: "done" });
    expect(resumed).toEqual([2, 3]);
  });

  it("cancel_during_final_wave_still_returns_done", async () => {
    // A Stop set DURING the last wave is unobservable to runPlan — the loop
    // exits before its next cancel check, so the outcome is Done with the flag
    // still set. This pins the contract that forces every spawner to re-check
    // the flag before running its reduce/epilogue work.
    const steps = [step(0, "local_llm")];
    const cancel = new CancelFlag();
    const outcome = await runPlan(
      steps,
      set(),
      cancel,
      async () => {
        cancel.store(true);
        return ok;
      },
      () => {},
      () => {}
    );
    expect(outcome).toEqual<RunOutcome>({ kind: "done" });
    expect(cancel.load()).toBe(true);
  });

  it("run_plan_parks_on_step_error", async () => {
    const steps = [step(0, "local_llm"), step(1, "local_llm", [0])];
    const ran: number[] = [];
    const outcome = await runPlan(
      steps,
      set(),
      never,
      async (s) => {
        ran.push(s.id);
        return s.id === 0 ? { ok: false, error: "OLLAMA_DOWN" } : ok;
      },
      () => {},
      () => {}
    );
    expect(outcome).toEqual<RunOutcome>({ kind: "error", error: "OLLAMA_DOWN" });
    expect(ran, "a step whose dependency failed never runs").toEqual([0]);
  });

  it("reports a plan that can never make progress instead of looping forever", async () => {
    // A dangling dependency (step 1 needs a nonexistent step 9): step 0 runs,
    // then nothing is dispatchable and nothing is running. `planIsStuck` must
    // catch that before the loop spins.
    const steps = [step(0, "cpu"), step(1, "cpu", [9])];
    const ran: number[] = [];
    const outcome = await runPlan(
      steps,
      set(),
      never,
      async (s) => {
        ran.push(s.id);
        return ok;
      },
      () => {},
      () => {}
    );
    expect(outcome).toEqual<RunOutcome>({ kind: "error", error: "job plan cannot make progress" });
    expect(ran).toEqual([0]);
  });

  it("run_plan_checkpoints_once_per_wave_not_once_per_step", async () => {
    // THE wave contract. Six independent cloud-lane steps (4 slots) run as
    // [0,1,2,3] then [4,5] and produce exactly TWO checkpoints. A per-node
    // checkpoint would record 1..6 — a different resume granularity and a
    // different crash-replay cost.
    const steps = [0, 1, 2, 3, 4, 5].map((i) => step(i, "cloud"));
    const cps: number[] = [];
    const ticks: Array<[number, number]> = [];
    const outcome = await runPlan(
      steps,
      set(),
      never,
      async () => ok,
      (done) => cps.push(densePrefix(done)),
      (done, total) => ticks.push([done, total])
    );
    expect(outcome).toEqual<RunOutcome>({ kind: "done" });
    expect(cps).toEqual([4, 6]);
    // Progress ticks once up front (the resume seed) and once per wave.
    expect(ticks).toEqual([
      [0, 6],
      [4, 6],
      [6, 6],
    ]);
  });

  it("run_plan_discards_a_failed_waves_completed_siblings", async () => {
    // A wave is atomic for checkpointing: every future in it is driven, but the
    // first error returns before `checkpoint` is ever called — so the SUCCEEDED
    // siblings of a failed step are NOT persisted and re-run on resume. This is
    // what makes "done stays a valid prefix" hold on a fan-out lane, and why
    // every step must be idempotent.
    const steps = [0, 1, 2, 3].map((i) => step(i, "cloud"));
    const ran: number[] = [];
    const cps: number[] = [];
    const outcome = await runPlan(
      steps,
      set(),
      never,
      async (s) => {
        ran.push(s.id);
        return s.id === 2 ? { ok: false, error: "OLLAMA_DOWN" } : ok;
      },
      (done) => cps.push(densePrefix(done)),
      () => {}
    );
    expect(outcome).toEqual<RunOutcome>({ kind: "error", error: "OLLAMA_DOWN" });
    // All four ran — the whole wave is awaited before the error surfaces…
    expect(ran.slice().sort()).toEqual([0, 1, 2, 3]);
    // …yet NOTHING was checkpointed, so the durable cursor stays put.
    expect(cps, "a failed wave must not checkpoint").toEqual([]);
  });

  it("run_plan_honors_a_real_done_set_but_a_prefix_seed_replays", async () => {
    // Two resume shapes ride the same entry point: a workflow seeds the REAL
    // done-set (an above-prefix id is honored and never re-runs), while
    // deep_summary/file_pass seed `0..densePrefix` (the same step REPLAYS,
    // which is only safe because every step is idempotent).
    const steps = [0, 1, 2, 3].map((i) => step(i, "local_llm"));
    const real = set(0, 1, 3);
    expect(densePrefix(real)).toBe(2);

    const ran: number[] = [];
    const ticks: Array<[number, number]> = [];
    const outcome = await runPlan(
      steps,
      real,
      never,
      async (s) => {
        ran.push(s.id);
        return ok;
      },
      () => {},
      (done, total) => ticks.push([done, total])
    );
    expect(outcome).toEqual<RunOutcome>({ kind: "done" });
    expect(ran).toEqual([2]);
    // The progress bar seeds from the COUNT (3 of 4) while the durable cursor a
    // spawner stores is the PREFIX (2) — a deliberate asymmetry.
    expect(ticks[0]).toEqual([3, 4]);

    // Same plan, prefix seed: step 3 runs a second time.
    const ran2: number[] = [];
    const outcome2 = await runPlan(
      steps,
      set(0, 1),
      never,
      async (s) => {
        ran2.push(s.id);
        return ok;
      },
      () => {},
      () => {}
    );
    expect(outcome2).toEqual<RunOutcome>({ kind: "done" });
    expect(ran2).toEqual([2, 3]);
  });

  it("run_plan_cancelled_before_the_first_wave_is_a_no_op", async () => {
    // Stop pressed while the job sat queued (or right at spawn): the flag is
    // checked at the TOP of the loop, so nothing executes and — crucially —
    // nothing is checkpointed, so the resume seed is exactly what it was.
    const steps = [0, 1, 2].map((i) => step(i, "local_llm"));
    const ran: number[] = [];
    const cps: number[] = [];
    const ticks: Array<[number, number]> = [];
    const outcome = await runPlan(
      steps,
      set(0),
      { load: () => true },
      async (s) => {
        ran.push(s.id);
        return ok;
      },
      (done) => cps.push(densePrefix(done)),
      (done, total) => ticks.push([done, total])
    );
    expect(outcome).toEqual<RunOutcome>({ kind: "paused" });
    expect(ran).toEqual([]);
    expect(cps).toEqual([]);
    // The seed tick still fires, so the Paused card reports real progress.
    expect(ticks).toEqual([[1, 3]]);
  });

  it("a_fully_cached_resume_is_done_with_no_work_and_no_checkpoint", async () => {
    // The reduce-retry path: every step's work is already cached, so a resume
    // seeds a COMPLETE done-set and runPlan returns Done having executed
    // nothing and checkpointed nothing.
    const steps = [0, 1, 2].map((i) => step(i, "local_llm"));
    const ran: number[] = [];
    const cps: number[] = [];
    const ticks: Array<[number, number]> = [];
    const outcome = await runPlan(
      steps,
      set(0, 1, 2),
      never,
      async (s) => {
        ran.push(s.id);
        return ok;
      },
      (done) => cps.push(densePrefix(done)),
      (done, total) => ticks.push([done, total])
    );
    expect(outcome).toEqual<RunOutcome>({ kind: "done" });
    expect(ran).toEqual([]);
    expect(cps).toEqual([]);
    expect(ticks).toEqual([[3, 3]]);
  });

  it("runs the step it dispatched, even when ids are not array indices", async () => {
    // `plan_dispatch` returns step IDs and the Rust `run_plan` then indexes
    // `steps[id]`, which is correct only because every plan builder assigns
    // `id = index`. This port resolves the id through the step list itself, so
    // a plan that does not hold that invariant runs the step it named rather
    // than silently running a different one (or `undefined`).
    const steps: Step[] = [
      { id: 10, lane: "cpu", kind: "first", params: null, dependsOn: [] },
      { id: 11, lane: "cpu", kind: "second", params: null, dependsOn: [10] },
    ];
    const ran: string[] = [];
    const outcome = await runPlan(
      steps,
      set(),
      never,
      async (s) => {
        ran.push(s.kind);
        return ok;
      },
      () => {},
      () => {}
    );
    expect(outcome).toEqual<RunOutcome>({ kind: "done" });
    expect(ran).toEqual(["first", "second"]);
  });

});

// ============================================================================
// crashReason
// ============================================================================

describe("crashReason", () => {
  it("a_panic_with_no_message_still_reports_a_crash", () => {
    // An empty or unknown payload must still say a crash happened — an empty
    // `error` column reads on screen as a job that stopped for no reason.
    expect(crashReason(new Error("mutex poisoned"))).toBe("the job runner crashed: mutex poisoned");
    expect(crashReason("index out of bounds")).toBe("the job runner crashed: index out of bounds");
    expect(crashReason(42)).toBe("the job runner crashed");
    expect(crashReason("   ")).toBe("the job runner crashed");
    expect(crashReason(new Error(""))).toBe("the job runner crashed");
    expect(crashReason(undefined)).toBe("the job runner crashed");
  });
});

// ============================================================================
// markJobsParking / parkRunningJobs / quiesceStaleJobs / parkCrashedJob
// ============================================================================

function legacyWorkflow(db: Database.Database, id: string, name: string): void {
  db.prepare("INSERT INTO workflows(id, name, definition) VALUES (?, ?, '{}')").run(id, name);
}

describe("quiesceStaleJobs", () => {
  it("quiesce_parks_running_jobs_keeps_queued_and_preserves_the_checkpoint", () => {
    // Room open after a crash/restart. A 'running' row belongs to a process
    // that is gone → park it 'paused' (Resume offered); a 'queued' row never
    // started → LEAVE it queued so the pump auto-starts it; terminal rows are
    // untouched; a workflow's inline CHILD is untouched (its parent re-drives
    // it). The checkpoint must survive intact.
    const db = freshRoom();
    const plan = { steps: [] };
    const running = createJob(db, "deep_summary", "Room summary", plan, 4);
    setJobStatus(db, running, "running", null);
    checkpointJob(db, running, 2, {});
    const queued = createJob(db, "deep_summary", "Indexing new files", { auto: true }, 2);
    const paused = createJob(db, "file_pass", "Full pass", plan, 4);
    setJobStatus(db, paused, "paused", null);
    const finished = createJob(db, "deep_summary", "old", plan, 1);
    setJobStatus(db, finished, "done", null);
    const failed = createJob(db, "deep_summary", "bad", plan, 1);
    setJobStatus(db, failed, "error", "OLLAMA_DOWN");
    const parent = createJob(db, "workflow", "Digest", plan, 2);
    const child = createChildJob(db, "file_pass", "Full pass — book.pdf", plan, 3, parent);
    setJobStatus(db, child, "running", null);

    quiesceStaleJobs(db);

    const st = (id: string): string => getJob(db, id).status;
    expect(st(running)).toBe("paused");
    expect(st(queued)).toBe("queued");
    expect(st(paused)).toBe("paused");
    expect(st(finished)).toBe("done");
    expect(st(failed)).toBe("error");
    // The child keeps 'running': unfinishedJobs hides it, so quiesce can't park
    // it out from under the workflow that owns it.
    expect(st(child)).toBe("running");

    const j = getJob(db, running);
    expect(j.cursor, "quiesce must not reset the checkpoint").toBe(2);
    expect(j.total).toBe(4);
    expect(getJob(db, failed).error).toBe("OLLAMA_DOWN");
    db.close();
  });

  it("quiesce_collapses_the_duplicate_it_just_created", () => {
    // The room-open ordering hole. `open_room` migrates (sweeping duplicate
    // parked rows) and only THEN quiesces. A workflow left 'running' by a crash
    // is invisible to that sweep, so the moment quiesce parks it the room holds
    // two indistinguishable cards for one workflow again.
    const db = freshRoom();
    legacyWorkflow(db, "wf-1", "Digest");
    legacyWorkflow(db, "wf-2", "Weekly");
    const plan = (trigger: string) => ({ workflow_id: "wf-1", trigger });
    // Both rows are minted while still 'queued', which is how the room really
    // got here — the write-site guard only ever retires a PARKED row.
    const stale = createJob(db, "workflow", "Workflow — Digest", plan("schedule"), 2);
    const live = createJob(db, "workflow", "Workflow — Digest", plan("manual"), 2);
    const other = createJob(db, "workflow", "Workflow — Weekly", { workflow_id: "wf-2" }, 1);
    setJobStatus(db, stale, "paused", null);
    // The run that superseded it, still 'running' because the app died.
    setJobStatus(db, live, "running", null);
    checkpointJob(db, live, 1, {});
    setJobStatus(db, other, "paused", null);

    quiesceStaleJobs(db);

    expect(
      listJobs(db)
        .map((j) => j.id)
        .sort(),
      "one card per workflow after a crash-open"
    ).toEqual([live, other].sort());
    // The survivor is the one that actually ran, checkpoint intact.
    const j = getJob(db, live);
    expect(j.status).toBe("paused");
    expect(j.cursor, "quiesce must not reset the checkpoint").toBe(1);
    db.close();
  });
});

/** The two DB writes `close_room` makes, in the order it makes them: stamp
 * every live row while the runners are still alive and the room is still open,
 * then force whatever is still 'running' when the room handle drops. Mirrors
 * the Rust suite's own `simulate_lock`. */
function simulateLock(db: Database.Database): void {
  markJobsParking(db, PARKED_BY_LOCK);
  parkRunningJobs(db, PARKED_BY_LOCK);
}

describe("lock/exit parking scenarios", () => {
  it("a_job_running_when_the_room_locks_is_parked_and_says_the_lock_did_it", () => {
    const db = freshRoom();
    const plan = { steps: [] };
    const running = createJob(db, "deep_summary", "Room summary", plan, 4);
    setJobStatus(db, running, "running", null);
    checkpointJob(db, running, 2, { points: ["a", "b"] });
    const queued = createJob(db, "file_pass", "Full pass", plan, 4);

    expect(markJobsParking(db, PARKED_BY_LOCK), "only the running row is stamped").toBe(1);
    expect(parkRunningJobs(db, PARKED_BY_LOCK)).toBe(1);

    const j = getJob(db, running);
    expect(j.status, "never left reading as running").toBe("paused");
    expect(j.parkedReason).toBe(PARKED_BY_LOCK);
    expect(j.cursor, "the checkpoint is what makes Resume worth offering").toBe(2);
    expect((j.state as { points: string[] }).points).toEqual(["a", "b"]);

    // A queued job never started, so it stays queued for the pump — and it is
    // left UNSTAMPED: the lock did not interrupt it, and the sentence could
    // never come true later.
    const q = getJob(db, queued);
    expect(q.status).toBe("queued");
    expect(q.parkedReason).toBeNull();
    db.close();
  });

  it("a_runner_that_stops_in_time_during_the_lock_still_reads_as_parked", () => {
    // A runner that DOES observe the cancel inside the drain window writes its
    // own 'paused' — and has no idea a lock caused it. Whether a job reads "you
    // paused this" or "the room was locked" must not come down to a two-second
    // race, so the reason is stamped up front and 'paused' preserves it.
    const db = freshRoom();
    const id = createJob(db, "file_pass", "Full pass", {}, 4);
    setJobStatus(db, id, "running", null);

    markJobsParking(db, PARKED_BY_LOCK);
    setJobStatus(db, id, "paused", null); // the runner's own epilogue
    parkRunningJobs(db, PARKED_BY_LOCK);

    const j = getJob(db, id);
    expect(j.status).toBe("paused");
    expect(j.parkedReason).toBe(PARKED_BY_LOCK);
    db.close();
  });

  it("a_job_that_finishes_inside_the_lock_drain_is_not_called_parked", () => {
    // The stamp is a prediction, and a job that beats it must not keep it.
    // "Done" plus "the room was locked while this was still running" is two
    // contradictory claims on one row, and the second one is the lie.
    const db = freshRoom();
    const id = createJob(db, "studio", "Flashcards", {}, 1);
    setJobStatus(db, id, "running", null);

    markJobsParking(db, PARKED_BY_LOCK);
    setJobStatus(db, id, "done", null);
    parkRunningJobs(db, PARKED_BY_LOCK);

    const j = getJob(db, id);
    expect(j.status).toBe("done");
    expect(j.parkedReason).toBeNull();
    db.close();
  });

  it("a_parked_job_resumes_from_its_checkpoint_and_drops_the_explanation", () => {
    const db = freshRoom();
    const id = createJob(db, "deep_summary", "Room summary", { steps: [] }, 4);
    setJobStatus(db, id, "running", null);
    checkpointJob(db, id, 3, { points: ["a"] });
    simulateLock(db);

    // What `resume_job` writes before handing the row to `queue::submit`.
    setJobStatus(db, id, "queued", null);

    const j = getJob(db, id);
    expect(j.status).toBe("queued");
    expect(j.parkedReason, "a resumed job stops explaining the lock").toBeNull();
    expect(j.cursor, "resumes where it got to, not from the top").toBe(3);
    expect((j.state as { points: string[] }).points).toEqual(["a"]);
    // And the pump can see it: this is the row `pumpOnOpen` starts.
    const next = unfinishedJobs(db);
    expect(next.length).toBe(1);
    expect(next[0]?.id).toBe(id);
    expect(next[0]?.status).toBe("queued");
    db.close();
  });

  it("a_job_the_user_stopped_is_never_blamed_on_the_app", () => {
    // The inverse lie. Stop is a deliberate choice, and dressing it up as "the
    // room was locked" would invent an interruption that never happened.
    const db = freshRoom();
    const id = createJob(db, "file_pass", "Full pass", {}, 4);
    setJobStatus(db, id, "running", null);
    setJobStatus(db, id, "paused", null);
    expect(getJob(db, id).parkedReason).toBeNull();
    db.close();
  });

  it("removing_a_job_from_the_queue_after_a_lock_is_not_blamed_on_the_lock", () => {
    // A QUEUED row is never parked by the app, so the sole way it reaches
    // 'paused' is the user pressing Remove. If the lock had stamped a reason on
    // the way past, `setJobStatus(.., "paused")` would preserve it (it must,
    // for the running runner's epilogue) and the card would blame the lock for
    // work the user removed by hand that had never started.
    const db = freshRoom();
    const queued = createJob(db, "file_pass", "Full pass", { steps: [] }, 4);

    simulateLock(db);
    expect(getJob(db, queued).status).toBe("queued");

    setJobStatus(db, queued, "paused", null);

    const j = getJob(db, queued);
    expect(j.status).toBe("paused");
    expect(
      j.parkedReason,
      "the user removed it; nothing interrupted it, and it never ran"
    ).toBeNull();
    db.close();
  });

  it("a_job_the_app_died_on_is_parked_at_the_next_unlock_and_named_as_such", () => {
    // No teardown runs on a crash or a force-quit, so the row is still
    // 'running' when the room is next opened. Quiesce has always parked it;
    // what it could not say is that NOBODY chose to stop it.
    const db = freshRoom();
    const plan = { steps: [] };
    const running = createJob(db, "deep_summary", "Room summary", plan, 4);
    setJobStatus(db, running, "running", null);
    checkpointJob(db, running, 2, {});
    // One the user really had paused before the crash: quiesce must not rewrite
    // its story on the way past.
    const paused = createJob(db, "file_pass", "Full pass", plan, 4);
    setJobStatus(db, paused, "paused", null);

    quiesceStaleJobs(db);

    const j = getJob(db, running);
    expect(j.status).toBe("paused");
    expect(j.parkedReason).toBe(PARKED_BY_EXIT);
    expect(j.cursor).toBe(2);
    expect(getJob(db, paused).parkedReason).toBeNull();
    db.close();
  });

  it("a workflow parked by the lock stops showing a live run", () => {
    // A workflow's run row must stop reading as 'running' too, or its history
    // line keeps a live green dot for a job that is parked.
    const db = freshRoom();
    legacyWorkflow(db, "wf-1", "Digest");
    const id = createJob(db, "workflow", "Workflow — Digest", { workflow_id: "wf-1" }, 2);
    db.prepare(
      "INSERT INTO workflow_runs(id, workflow_id, job_id, status) VALUES ('r1','wf-1',?,'running')"
    ).run(id);
    setJobStatus(db, id, "running", null);

    simulateLock(db);

    const run = db.prepare("SELECT status, finished_at FROM workflow_runs WHERE id = 'r1'").get() as {
      status: string;
      finished_at: string | null;
    };
    expect(run.status).toBe("paused");
    expect(run.finished_at, "a pause is not a finish — a resume can still close it").toBeNull();
    db.close();
  });
});

describe("parkCrashedJob", () => {
  it("a_crashed_runner_leaves_every_live_row_terminal_and_says_why", () => {
    // The exit path nobody writes code for: before `spawn_job_runner` the row
    // simply stayed 'running' for the rest of the session, with a live progress
    // bar and a queue slot nothing would ever free. Both live statuses must end
    // terminal, and the reason must reach the row's `error` column — the
    // Sidebar renders it, and "Stopped — " with nothing after it explains
    // nothing.
    const db = freshRoom();
    const plan = { steps: [] };
    const running = createJob(db, "deep_summary", "Room summary", plan, 4);
    setJobStatus(db, running, "running", null);
    checkpointJob(db, running, 3, {});
    const queued = createJob(db, "file_pass", "Full pass", plan, 4);

    const reason = crashReason(new Error("index out of bounds"));
    // The row's OWN checkpoint comes back, so the terminal event reports the
    // progress the job really made instead of inventing 0.
    expect(parkCrashedJob(db, running, reason)).toEqual({ cursor: 3, total: 4 });
    expect(parkCrashedJob(db, queued, reason)).toEqual({ cursor: 0, total: 4 });

    const st = (id: string): string => getJob(db, id).status;
    expect(st(running)).toBe("error");
    expect(st(queued)).toBe("error");
    const err = getJob(db, running).error as string;
    expect(err).toContain("crashed");
    expect(err).toContain("index out of bounds");
    // The checkpoint survives, so Retry resumes rather than restarting.
    expect(getJob(db, running).cursor).toBe(3);
    db.close();
  });

  it("a_crash_after_the_epilogue_never_rewrites_a_finished_job", () => {
    // The failure can land AFTER the runner wrote its own terminal status — in
    // the progress emit, in `finishAndPump`. Overwriting 'done' with 'error'
    // there would be this app's own prose fabricating a failure that did not
    // happen; 'paused' is already honest and resumable.
    const db = freshRoom();
    for (const [status, err] of [
      ["done", null],
      ["paused", null],
      ["error", "OLLAMA_DOWN"],
    ] as const) {
      const id = createJob(db, "deep_summary", "s", { steps: [] }, 1);
      setJobStatus(db, id, status, err);
      expect(parkCrashedJob(db, id, "crashed")).toBeNull();
      const job = getJob(db, id);
      expect(job.status).toBe(status);
      expect(job.error).toBe(err);
    }
    db.close();
  });

  it("closes a crashed workflow's open run row too", () => {
    const db = freshRoom();
    legacyWorkflow(db, "wf-1", "Digest");
    const id = createJob(db, "workflow", "Workflow — Digest", { workflow_id: "wf-1" }, 2);
    db.prepare(
      "INSERT INTO workflow_runs(id, workflow_id, job_id, status) VALUES ('r1','wf-1',?,'running')"
    ).run(id);
    setJobStatus(db, id, "running", null);

    parkCrashedJob(db, id, "the job runner crashed: boom");

    const run = db.prepare("SELECT status, finished_at FROM workflow_runs WHERE id = 'r1'").get() as {
      status: string;
      finished_at: string | null;
    };
    expect(run.status).toBe("error");
    expect(run.finished_at).not.toBeNull();
    db.close();
  });
});

// ============================================================================
// spawnJobRunner — crash safety and the room pin
// ============================================================================

function fakeSink(): { sink: ProgressSink; events: JobProgressPayload[] } {
  const events: JobProgressPayload[] = [];
  return { sink: { emit: (p) => events.push(p) }, events };
}

function fakeRooms(handle: RoomHandle | null): {
  rooms: RoomSource;
  set(h: RoomHandle | null): void;
} {
  let current = handle;
  return {
    rooms: { current: () => current },
    set(h) {
      current = h;
    },
  };
}

function fakeDeps(
  rooms: RoomSource,
  sink: ProgressSink
): JobRunnerDeps & { removed: string[]; settled: string[]; render?: RenderPodcastAudio } {
  const removed: string[] = [];
  const settled: string[] = [];
  return {
    rooms,
    sink,
    removed,
    settled,
    removeCancelFlag: (id) => removed.push(id),
    onSettled: (id) => {
      settled.push(id);
    },
  };
}

describe("spawnJobRunner", () => {
  it("a body that throws still parks the running job, reports its own checkpoint, and settles", async () => {
    const db = freshRoom();
    const id = createJob(db, "deep_summary", "Room summary", {}, 4);
    setJobStatus(db, id, "running", null);
    checkpointJob(db, id, 2, {});
    const { rooms } = fakeRooms({ db, path: "room-a" });
    const { sink, events } = fakeSink();
    const deps = fakeDeps(rooms, sink);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await spawnJobRunner(deps, id, "room-a", async () => {
      throw new Error("a poisoned mutex, an index out of range");
    });

    const row = getJob(db, id);
    expect(row.status).toBe("error");
    expect(row.error).toContain("the job runner crashed");
    expect(row.error).toContain("poisoned mutex");
    expect(row.cursor, "the row's own checkpoint, not a fabricated 0").toBe(2);
    expect(events).toEqual([
      {
        jobId: id,
        label: "Stopped — the job runner crashed: a poisoned mutex, an index out of range",
        done: 2,
        total: 4,
        failed: true,
      },
    ]);
    expect(deps.removed).toEqual([id]);
    expect(deps.settled).toEqual([id]);
    db.close();
  });

  it("a body that completes normally never touches the crash path", async () => {
    const db = freshRoom();
    const id = createJob(db, "workflow", "w", {}, 1);
    setJobStatus(db, id, "running", null);
    const { rooms } = fakeRooms({ db, path: "room-a" });
    const { sink, events } = fakeSink();
    const deps = fakeDeps(rooms, sink);
    let ranBody = false;

    await spawnJobRunner(deps, id, "room-a", async () => {
      ranBody = true;
      // The body owns its own epilogue — nothing here calls onSettled.
      setJobStatus(db, id, "done", null);
    });

    expect(ranBody).toBe(true);
    expect(getJob(db, id).status).toBe("done");
    expect(deps.removed).toEqual([]);
    expect(deps.settled).toEqual([]);
    expect(events).toEqual([]);
    db.close();
  });

  it("a crash landing after the job already finished never rewrites it", async () => {
    const db = freshRoom();
    const id = createJob(db, "workflow", "w", {}, 1);
    setJobStatus(db, id, "done", null);
    const { rooms } = fakeRooms({ db, path: "room-a" });
    const { sink, events } = fakeSink();
    const deps = fakeDeps(rooms, sink);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await spawnJobRunner(deps, id, "room-a", async () => {
      throw new Error("late crash");
    });

    expect(getJob(db, id).status, "already-terminal rows are left alone").toBe("done");
    // No checkpoint to report, since parkCrashedJob returned null.
    expect(events).toEqual([]);
    expect(deps.settled, "the queue slot is freed either way").toEqual([id]);
    db.close();
  });

  it("a crash against a room the job no longer belongs to writes nothing (still settles)", async () => {
    // The room pin: a crash after the room was swapped or closed must not park
    // a row in a DIFFERENT room.
    const { rooms } = fakeRooms(null); // no room open
    const { sink, events } = fakeSink();
    const deps = fakeDeps(rooms, sink);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await spawnJobRunner(deps, "job-1", "room-a", async () => {
      throw new Error("boom");
    });

    expect(events, "nothing to report — no row was parked").toEqual([]);
    expect(deps.removed).toEqual(["job-1"]);
    expect(deps.settled).toEqual(["job-1"]);
  });

  it("a failing epilogue callback cannot escape and strand the queue", async () => {
    // The last line of defence: whatever this wrapper's own recovery path
    // touches, an exception thrown out of IT would be an unhandled rejection
    // nobody can observe — the exact silent failure the wrapper exists to
    // prevent. The pump must still be attempted, and the promise must settle.
    const { rooms } = fakeRooms(null);
    const { sink } = fakeSink();
    let pumped = false;
    const deps: JobRunnerDeps = {
      rooms,
      sink,
      removeCancelFlag: () => {
        throw new Error("the cancel registry is gone");
      },
      onSettled: () => {
        pumped = true;
        throw new Error("the pump itself failed");
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      spawnJobRunner(deps, "job-1", "room-a", async () => {
        throw new Error("boom");
      })
    ).resolves.toBeUndefined();
    expect(pumped).toBe(true);
  });
});

// ============================================================================
// spawnPodcastAudio
// ============================================================================

describe("spawnPodcastAudio", () => {
  it("with no render dependency, reaches NOT_IMPLEMENTED as a real error path", async () => {
    const db = freshRoom();
    const id = createJob(db, "podcast_audio", "Podcast episode", { scriptFileId: "f1" }, 1);
    const { rooms } = fakeRooms({ db, path: "room-a" });
    const { sink, events } = fakeSink();
    const deps = fakeDeps(rooms, sink);

    await spawnPodcastAudio(deps, id, "room-a", "f1", new CancelFlag());

    const row = getJob(db, id);
    expect(row.status).toBe("error");
    expect(row.error, "never a fabricated success, never a bare crash").toBe(
      PODCAST_RENDER_NOT_IMPLEMENTED
    );
    expect(events[0]).toEqual({ jobId: id, label: "Reading the script…", done: 0, total: 1 });
    expect(events[events.length - 1]).toEqual({
      jobId: id,
      label: `Stopped — ${PODCAST_RENDER_NOT_IMPLEMENTED}`,
      done: 0,
      total: 1,
      failed: true,
    });
    expect(deps.removed).toEqual([id]);
    expect(deps.settled).toEqual([id]);
    db.close();
  });

  it("the default stub itself fails with a labeled reason (never a silent success)", async () => {
    await expect(renderPodcastAudioNotImplemented("f1", new CancelFlag())).rejects.toThrow(
      "NOT_IMPLEMENTED"
    );
  });

  it("a successful render marks the job done and names the produced file", async () => {
    const db = freshRoom();
    const id = createJob(db, "podcast_audio", "Podcast episode", { scriptFileId: "f1" }, 1);
    const { rooms } = fakeRooms({ db, path: "room-a" });
    const { sink, events } = fakeSink();
    const deps = fakeDeps(rooms, sink);
    const cancel = new CancelFlag();
    const render = vi.fn(async () => ({ id: "episode-file-id" }));
    deps.render = render;

    await spawnPodcastAudio(deps, id, "room-a", "f1", cancel);

    expect(render).toHaveBeenCalledWith("f1", cancel);
    expect(getJob(db, id).status).toBe("done");
    expect(events[events.length - 1]).toEqual({
      jobId: id,
      label: "Episode ready",
      done: 1,
      total: 1,
      finished: true,
      fileId: "episode-file-id",
    });
    expect(deps.settled).toEqual([id]);
    db.close();
  });

  it("a render error while the cancel flag is set is reported as a clean Pause", async () => {
    // The same convention the studio runner uses: an error raised because the
    // user pressed Stop is not a failure to explain.
    const db = freshRoom();
    const id = createJob(db, "podcast_audio", "Podcast episode", { scriptFileId: "f1" }, 1);
    const { rooms } = fakeRooms({ db, path: "room-a" });
    const { sink, events } = fakeSink();
    const deps = fakeDeps(rooms, sink);
    const cancel = new CancelFlag();
    deps.render = async () => {
      cancel.store(true);
      throw new Error("stopped mid-request");
    };

    await spawnPodcastAudio(deps, id, "room-a", "f1", cancel);

    const row = getJob(db, id);
    expect(row.status).toBe("paused");
    expect(row.error, "a pause has nothing to explain").toBeNull();
    expect(events[events.length - 1]).toEqual({
      jobId: id,
      label: "Paused",
      done: 0,
      total: 1,
      paused: true,
    });
    db.close();
  });

  it("a genuine render failure (cancel NOT set) parks the job with the real reason", async () => {
    const db = freshRoom();
    const id = createJob(db, "podcast_audio", "Podcast episode", { scriptFileId: "f1" }, 1);
    const { rooms } = fakeRooms({ db, path: "room-a" });
    const { sink, events } = fakeSink();
    const deps = fakeDeps(rooms, sink);
    deps.render = async () => {
      throw new Error("the voice service is unreachable");
    };

    await spawnPodcastAudio(deps, id, "room-a", "f1", new CancelFlag());

    const row = getJob(db, id);
    expect(row.status).toBe("error");
    expect(
      row.error,
      "a failed render is its own reason, not 'the job runner crashed'"
    ).toBe("the voice service is unreachable");
    const terminal = events[events.length - 1] as JobProgressPayload;
    expect(terminal.label).toBe("Stopped — the voice service is unreachable");
    expect(terminal.failed).toBe(true);
    db.close();
  });

  it("a room swapped out from under the job writes nothing to the wrong room", async () => {
    const dbA = freshRoom();
    const id = createJob(dbA, "podcast_audio", "Podcast episode", { scriptFileId: "f1" }, 1);
    const { rooms, set } = fakeRooms({ db: dbA, path: "room-a" });
    const { sink, events } = fakeSink();
    const deps = fakeDeps(rooms, sink);
    deps.render = async () => {
      // Simulate the room swapping mid-render.
      set(null);
      return { id: "episode-file-id" };
    };

    await spawnPodcastAudio(deps, id, "room-a", "f1", new CancelFlag());

    // Room A's row was never touched past its initial 'running' write — this
    // job's terminal write is skipped because the pin no longer matches,
    // exactly like every runner in `jobs.rs` re-checking `room.path`.
    expect(getJob(dbA, id).status).toBe("running");
    // The terminal EVENT still fires (it does not require the room) — only the
    // DB write is pinned.
    expect((events[events.length - 1] as JobProgressPayload).finished).toBe(true);
    dbA.close();
  });
});
