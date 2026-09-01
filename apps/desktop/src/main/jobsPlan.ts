/** Pure lane scheduling and resumable plan execution. */

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

function availableLaneSlots(): Map<Lane, number> {
  return new Map<Lane, number>(ALL_LANES.map((lane) => [lane, laneSlots(lane)]));
}

function reserveRunningSlots(steps: readonly Step[], running: ReadonlySet<number>, free: Map<Lane, number>): void {
  for (const step of steps) {
    if (running.has(step.id)) {
      free.set(step.lane, Math.max(0, (free.get(step.lane) ?? 0) - 1));
    }
  }
}

function canDispatchStep(step: Step, done: ReadonlySet<number>, running: ReadonlySet<number>): boolean {
  return !done.has(step.id) && !running.has(step.id) && step.dependsOn.every((dependency) => done.has(dependency));
}

function reserveDispatchSlot(free: Map<Lane, number>, lane: Lane): boolean {
  const slot = free.get(lane) ?? 0;
  if (slot === 0) {
    return false;
  }
  free.set(lane, slot - 1);
  return true;
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
  const free = availableLaneSlots();
  reserveRunningSlots(steps, running, free);
  const chosen: number[] = [];
  for (const step of steps) {
    if (canDispatchStep(step, done, running) && reserveDispatchSlot(free, step.lane)) {
      chosen.push(step.id);
    }
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
