/**
 * Vitest port of the `commands/jobs/queue.rs` tests
 * (`src-tauri/src/commands/jobs/queue.rs`, `mod tests`):
 *
 *   - reserve_is_single_slot
 *   - queued_count_and_cap
 *   - an_unreadable_queue_counts_as_full_rather_than_empty
 *   - the_slot_is_released_when_its_holder_belongs_to_another_room
 *
 * NOT ported: `every_runner_that_owns_its_epilogue_frees_the_slot` greps FOUR
 * OTHER Rust source files (`rec_read.rs`, `download.rs`, `workflow.rs`,
 * `create.rs`) for a `finish_and_pump` call. None of those job kinds have an
 * Electron port yet (this batch explicitly excludes them), so there is nothing
 * to grep. The invariant it guards is instead structural here: a runner started
 * by this queue gets its `onSettled` from {@link runnerDepsFrom}, which always
 * calls {@link finishAndPump} — a future kind cannot forget it without
 * deliberately building its own deps.
 *
 * PLUS coverage this port adds for `submit`/`pump`/`startJobFromRow`'s own
 * orchestration, none of which is unit-testable in the Rust source without the
 * full Tauri `AppState`: FIFO order, the poisoned-row path, an unknown kind, a
 * starter that throws, and the real `podcast_audio` row-starter.
 */

import Database from "better-sqlite3-multiple-ciphers";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CancelFlag, createCancelState } from "./cancel.js";
import { createRoom } from "./db-host/open.js";
import { createJob, getJob, setJobStatus, unfinishedJobs } from "./db-host/jobs.js";
import type { JobProgressPayload, ProgressSink, RoomHandle, RoomSource } from "./jobs.js";
import {
  atCapacity,
  createJobQueueState,
  defaultRowStarters,
  finishAndPump,
  type JobQueueDeps,
  MAX_QUEUED,
  notImplementedRowStarter,
  planString,
  podcastAudioRowStarter,
  pump,
  pumpOnOpen,
  queuedCount,
  type RowStarter,
  submit,
  tryReserve,
  UNKNOWN_JOB_KIND,
  UNREADABLE_PLAN,
} from "./jobQueue.js";

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

function freshRoom(): Database.Database {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "job-queue-"));
  const roomPath = path.join(tmpDir, `pr-test-${Math.random().toString(36).slice(2)}.roomai`);
  return createRoom(roomPath, "correct horse battery staple", "Test Room");
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

function fakeSink(): { sink: ProgressSink; events: JobProgressPayload[] } {
  const events: JobProgressPayload[] = [];
  return { sink: { emit: (p) => events.push(p) }, events };
}

/** A queue wired over a real fixture room (or `null` for "no room open"). */
function makeQueue(
  db: Database.Database | null,
  starters: ReadonlyMap<string, RowStarter> = new Map(),
  roomPath = "mem://room"
): { deps: JobQueueDeps; events: JobProgressPayload[]; setRoom(h: RoomHandle | null): void } {
  const { rooms, set } = fakeRooms(db === null ? null : { db, path: roomPath });
  const { sink, events } = fakeSink();
  return {
    deps: {
      state: createJobQueueState(),
      rooms,
      sink,
      cancelState: createCancelState(),
      starters,
    },
    events,
    setRoom: set,
  };
}

/**
 * A promise this test controls the settling of — used as `render` so a test can
 * observe the queue slot HELD while the (stubbed) podcast render is still "in
 * flight", then observe it freed once the render settles. Without it, a render
 * that settles INSTANTLY races the foreground `submit`/`pump` promise chain on
 * the same microtask queue, and which one wins is an implementation accident
 * rather than behaviour worth pinning.
 */
function deferredRender(): {
  render: () => Promise<{ id: string }>;
  resolve: (id: string) => void;
} {
  let settle!: (v: { id: string }) => void;
  const promise = new Promise<{ id: string }>((res) => {
    settle = res;
  });
  return { render: () => promise, resolve: (id) => settle({ id }) };
}

describe("tryReserve", () => {
  it("reads only string fields from fabricated persisted job plans", () => {
    expect(planString({ scriptFileId: "script-1", blank: "" }, "scriptFileId")).toBe("script-1");
    expect(planString({ scriptFileId: "script-1", blank: "" }, "blank")).toBe("");
    for (const plan of [null, [], "not a plan", 3, { scriptFileId: false }, {}]) {
      expect(planString(plan, "scriptFileId")).toBeNull();
    }
  });

  it("reserve_is_single_slot", () => {
    const state = createJobQueueState();
    expect(tryReserve(state, "a")).toBe(true);
    // Slot taken — a second reserve fails until it's freed.
    expect(tryReserve(state, "b")).toBe(false);
    state.runningJob = null;
    expect(tryReserve(state, "b")).toBe(true);
    expect(state.runningJob).toBe("b");
  });
});

describe("queuedCount / atCapacity", () => {
  it("queued_count_and_cap", () => {
    const db = freshRoom();
    expect(queuedCount(db)).toBe(0);
    for (let i = 0; i < 3; i++) {
      createJob(db, "workflow", `w${i}`, {}, 1);
    }
    expect(queuedCount(db)).toBe(3);
    expect(3).toBeLessThan(MAX_QUEUED);
    expect(atCapacity(db)).toBe(false);
    // A running job is not counted as queued.
    const running = createJob(db, "workflow", "r", {}, 1);
    setJobStatus(db, running, "running", null);
    expect(queuedCount(db)).toBe(3);
    db.close();
  });

  it("an_unreadable_queue_counts_as_full_rather_than_empty", () => {
    // The cap is a protection: if the jobs table can't be read we must NOT
    // guess "there's room" — that is exactly when a runaway scheduler would
    // pile work up unchecked.
    const db = new Database(":memory:"); // no `jobs` table
    expect(() => queuedCount(db)).toThrow();
    expect(atCapacity(db), "an unreadable queue must refuse new work").toBe(true);
    db.close();
  });
});

describe("slotFreeForThisRoom (exercised via pump)", () => {
  it("the_slot_is_released_when_its_holder_belongs_to_another_room", async () => {
    // Switching rooms leaves the slot claimed by the old room's job until that
    // job notices the cancel — which can be minutes inside a model call. The
    // new room's queue must not wait on it.
    const db = freshRoom();
    const { deps, setRoom } = makeQueue(db, new Map(), "mem://new-room");

    // A job of the room that IS open holds the slot → genuinely busy.
    const mine = createJob(db, "workflow", "w", {}, 1);
    setJobStatus(db, mine, "running", null);
    expect(tryReserve(deps.state, mine)).toBe(true);
    await pump(deps);
    expect(deps.state.runningJob).toBe(mine);

    // A job id this room has never heard of cannot be running against it — the
    // stale claim is dropped, and the (now-empty) queue pumps harmlessly.
    deps.state.runningJob = "job-from-the-previous-room";
    await pump(deps);
    expect(deps.state.runningJob, "the stale claim is dropped").toBeNull();

    // With no room open there is nothing to pump, so the slot stays as-is.
    deps.state.runningJob = "whatever";
    setRoom(null);
    await pump(deps);
    expect(deps.state.runningJob).toBe("whatever");
    db.close();
  });
});

describe("submit / pump orchestration", () => {
  it("starts immediately when the slot is free, and the runner keeps it", async () => {
    const db = freshRoom();
    const started: string[] = [];
    const starter: RowStarter = async (_deps, job) => {
      started.push(job.id);
      return { kind: "runner" };
    };
    const { deps } = makeQueue(db, new Map([["workflow", starter]]));
    const id = createJob(db, "workflow", "w", {}, 1);

    await submit(deps, id);

    expect(started).toEqual([id]);
    // A "runner" outcome holds the slot — its own epilogue frees it.
    expect(deps.state.runningJob).toBe(id);
    // And it holds the cancel flag the starter was handed, in the registry
    // `cancel.ts`'s `cancelId` already reads.
    expect(deps.cancelState.jobCancels.has(id)).toBe(true);
    db.close();
  });

  it("leaves a row queued when the slot is busy, and finishAndPump starts it next", async () => {
    const db = freshRoom();
    const started: string[] = [];
    const starter: RowStarter = async (_deps, job) => {
      started.push(job.id);
      setJobStatus(db, job.id, "running", null); // what a real spawner does first
      return { kind: "runner" };
    };
    const { deps } = makeQueue(db, new Map([["workflow", starter]]));

    const busy = createJob(db, "workflow", "busy", {}, 1);
    setJobStatus(db, busy, "running", null);
    expect(tryReserve(deps.state, busy)).toBe(true);

    const waiting = createJob(db, "workflow", "waiting", {}, 1);
    await submit(deps, waiting);
    expect(started, "submit's own reserve failed — nothing started").toEqual([]);
    expect(getJob(db, waiting).status).toBe("queued");

    // The busy job finishes: its epilogue frees the slot and pumps the next.
    setJobStatus(db, busy, "done", null);
    await finishAndPump(deps, busy);
    expect(started).toEqual([waiting]);
    expect(deps.state.runningJob).toBe(waiting);
    db.close();
  });

  it("pump starts the OLDEST queued row first", async () => {
    const db = freshRoom();
    const started: string[] = [];
    const starter: RowStarter = async (_deps, job) => {
      started.push(job.id);
      // A real "immediate" starter has already written a terminal status before
      // returning (e.g. an auto-index with nothing to do writes 'done').
      setJobStatus(db, job.id, "done", null);
      return { kind: "immediate" };
    };
    const { deps } = makeQueue(db, new Map([["workflow", starter]]));

    const first = createJob(db, "workflow", "first", {}, 1);
    db.prepare("UPDATE jobs SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(first);
    const second = createJob(db, "workflow", "second", {}, 1);
    db.prepare("UPDATE jobs SET created_at = '2020-01-02T00:00:00Z' WHERE id = ?").run(second);

    await pump(deps);

    expect(started).toEqual([first, second]);
    expect(unfinishedJobs(db)).toEqual([]);
    expect(deps.state.runningJob, "an immediate finish frees the slot").toBeNull();
    db.close();
  });

  it("a poisoned row is marked error, and the pump continues to the next row", async () => {
    const db = freshRoom();
    const started: string[] = [];
    const starters = new Map<string, RowStarter>([
      ["studio", notImplementedRowStarter("studio")],
      [
        "workflow",
        async (_deps, job) => {
          started.push(job.id);
          setJobStatus(db, job.id, "running", null);
          return { kind: "runner" };
        },
      ],
    ]);
    const { deps } = makeQueue(db, starters);

    const poisoned = createJob(db, "studio", "Flashcards", {}, 1);
    const good = createJob(db, "workflow", "w", {}, 1);

    await submit(deps, poisoned);

    // The poisoned row is terminal (the Sidebar shows Retry), never left stuck
    // queued forever, and the pump moved straight on to the next row.
    expect(getJob(db, poisoned).status).toBe("error");
    expect(getJob(db, poisoned).error).toContain("NOT_IMPLEMENTED");
    expect(deps.cancelState.jobCancels.has(poisoned), "its flag was dropped").toBe(false);
    expect(started).toEqual([good]);
    expect(deps.state.runningJob).toBe(good);
    db.close();
  });

  it("a genuinely unknown job kind gets Rust's own literal refusal", async () => {
    // "Not ported yet" and "not a real job kind at all" stay two different
    // sentences — the first names the porting gap, the second is what the Rust
    // source says today.
    const db = freshRoom();
    const { deps } = makeQueue(db);
    const id = createJob(db, "some_future_kind", "x", {}, 1);

    await submit(deps, id);

    expect(getJob(db, id).status).toBe("error");
    expect(getJob(db, id).error).toBe(UNKNOWN_JOB_KIND);
    expect(deps.state.runningJob, "the slot is freed for the next job").toBeNull();
    db.close();
  });

  it("releases the reserved slot when the submitted row cannot be read", async () => {
    const db = freshRoom();
    const { deps } = makeQueue(db);

    await expect(submit(deps, "missing-job-row")).resolves.toBeUndefined();

    expect(deps.state.runningJob, "the unreadable row cannot strand the queue").toBeNull();
    expect(deps.cancelState.jobCancels.has("missing-job-row"), "no cancel flag was registered").toBe(
      false,
    );
    db.close();
  });

  it("a starter that THROWS poisons its own row instead of wedging the queue", async () => {
    // Rust's starters return `Result`, so this state is unreachable there. Here
    // an escaping rejection would reject `pump` — usually called unawaited from
    // a runner's epilogue — and leave the slot reserved for the rest of the
    // session, so every later job would wait on a job that already ended.
    const db = freshRoom();
    const starters = new Map<string, RowStarter>([
      [
        "file_pass",
        () => {
          throw new Error("the plan reader blew up");
        },
      ],
    ]);
    const { deps } = makeQueue(db, starters);
    const id = createJob(db, "file_pass", "big.pdf", {}, 3);

    await expect(submit(deps, id)).resolves.toBeUndefined();

    expect(getJob(db, id).status).toBe("error");
    expect(getJob(db, id).error).toBe("the plan reader blew up");
    expect(deps.state.runningJob, "the slot is not stranded").toBeNull();
    db.close();
  });

  it("stops rather than spinning when a start cannot be recorded", async () => {
    // If the room refused the 'error' write the row is STILL 'queued', so
    // continuing would re-pick it immediately and spin at full processor speed.
    const db = freshRoom();
    // The room goes away between reading the row and recording the failure.
    let closeTheRoom: () => void = () => {};
    const starters = new Map<string, RowStarter>([
      [
        "workflow",
        async () => {
          closeTheRoom();
          return { kind: "error", message: "nope" };
        },
      ],
    ]);
    const { deps, setRoom } = makeQueue(db, starters);
    closeTheRoom = () => setRoom(null);
    const id = createJob(db, "workflow", "x", {}, 1);

    await submit(deps, id);

    expect(getJob(db, id).status, "nothing could be written").toBe("queued");
    expect(deps.state.runningJob, "but the slot is still released").toBeNull();
    db.close();
  });

  it("a row that never leaves the queue is picked at most once per pass", async () => {
    // The hot-loop guard. The pump's contract is that a "continue" outcome took
    // the row off 'queued'; a starter that reports finished-synchronously
    // WITHOUT writing a terminal status would otherwise be handed the same row
    // forever, at full processor speed, with no way out.
    const db = freshRoom();
    let calls = 0;
    const starters = new Map<string, RowStarter>([
      [
        "workflow",
        async () => {
          calls += 1;
          return { kind: "immediate" }; // and deliberately writes no status
        },
      ],
    ]);
    const { deps } = makeQueue(db, starters);
    createJob(db, "workflow", "w", {}, 1);

    await pump(deps);

    expect(calls, "the misbehaving row is tried once, then the pass ends").toBe(1);
    db.close();
  });

  it("submit is a no-op when something else already holds the slot", async () => {
    const db = freshRoom();
    const { deps } = makeQueue(db);
    expect(tryReserve(deps.state, "someone-else")).toBe(true);
    const id = createJob(db, "workflow", "w", {}, 1);

    await submit(deps, id);

    expect(getJob(db, id).status).toBe("queued");
    expect(deps.state.runningJob).toBe("someone-else");
    db.close();
  });
});

describe("the podcast_audio row-starter", () => {
  it("holds the slot while the render is in flight, and frees it at the epilogue", async () => {
    const db = freshRoom();
    const { render, resolve } = deferredRender();
    const { deps } = makeQueue(db, defaultRowStarters(render));
    const id = createJob(db, "podcast_audio", "Podcast episode", { scriptFileId: "f1" }, 1);

    await submit(deps, id);

    // The starter fires the runner without awaiting it, so the row is already
    // "running" against a held slot while the render is still outstanding.
    expect(deps.state.runningJob).toBe(id);
    expect(getJob(db, id).status).toBe("running");

    resolve("episode-1");
    await new Promise((r) => setTimeout(r, 0));

    expect(getJob(db, id).status).toBe("done");
    expect(deps.state.runningJob, "its own epilogue freed the slot").toBeNull();
    expect(deps.cancelState.jobCancels.has(id)).toBe(false);
    db.close();
  });

  it("drives the stubbed renderer through a real error path", async () => {
    const db = freshRoom();
    const { deps } = makeQueue(db, defaultRowStarters()); // no render supplied
    const id = createJob(db, "podcast_audio", "Podcast episode", { scriptFileId: "f1" }, 1);

    await submit(deps, id);
    await new Promise((r) => setTimeout(r, 0));

    expect(getJob(db, id).status).toBe("error");
    expect(getJob(db, id).error).toContain("NOT_IMPLEMENTED");
    expect(deps.state.runningJob).toBeNull();
    db.close();
  });

  it("refuses a plan carrying no scriptFileId, before any render is attempted", async () => {
    const db = freshRoom();
    let rendered = false;
    const { deps } = makeQueue(
      db,
      new Map([
        [
          "podcast_audio",
          podcastAudioRowStarter(async () => {
            rendered = true;
            return { id: "x" };
          }),
        ],
      ])
    );
    const id = createJob(db, "podcast_audio", "Podcast episode", { notTheRightShape: true }, 1);

    await submit(deps, id);

    expect(getJob(db, id).status).toBe("error");
    expect(getJob(db, id).error).toBe(UNREADABLE_PLAN);
    expect(rendered).toBe(false);
    db.close();
  });

  it("hands the runner the very cancel flag the queue registered", async () => {
    const db = freshRoom();
    let seen: CancelFlag | null = null;
    const starters = new Map<string, RowStarter>([
      [
        "podcast_audio",
        async (_deps, _job, _roomPath, cancel) => {
          seen = cancel;
          return { kind: "runner" };
        },
      ],
    ]);
    const { deps } = makeQueue(db, starters);
    const id = createJob(db, "podcast_audio", "y", { scriptFileId: "f1" }, 1);

    await submit(deps, id);

    expect(seen).toBeInstanceOf(CancelFlag);
    expect(seen, "the same object, so a Stop reaches the running work").toBe(
      deps.cancelState.jobCancels.get(id)
    );
    db.close();
  });
});

describe("pumpOnOpen", () => {
  it("restarts a job left 'queued' from a previous session", async () => {
    const db = freshRoom();
    const { render, resolve } = deferredRender();
    const { deps } = makeQueue(db, defaultRowStarters(render));
    const id = createJob(db, "podcast_audio", "Podcast episode", { scriptFileId: "f1" }, 1);

    pumpOnOpen(deps);
    // `pump` reserves the slot SYNCHRONOUSLY (its `tryReserve` runs before the
    // loop's only `await`), so this is observable with no wait.
    expect(deps.state.runningJob).toBe(id);

    resolve("episode-1");
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.state.runningJob).toBeNull();
    db.close();
  });
});
