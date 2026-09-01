import { afterEach, describe, expect, it, vi } from "vitest";
import { createCancelState } from "./cancel.js";
import type { Job } from "./db-host/jobs.js";

const fakes = vi.hoisted(() => ({
  getJob: vi.fn(),
  setJobStatus: vi.fn(),
  unfinishedJobs: vi.fn(),
  spawnPodcastAudio: vi.fn(),
}));

vi.mock("./db-host/jobs.js", () => ({
  getJob: fakes.getJob,
  setJobStatus: fakes.setJobStatus,
  unfinishedJobs: fakes.unfinishedJobs,
}));
vi.mock("./jobs.js", () => ({ spawnPodcastAudio: fakes.spawnPodcastAudio }));

import { createJobQueueState, pump, type JobQueueDeps, type RowStarter } from "./jobQueue.js";

function queuedJob(id: string): Job {
  return {
    id,
    kind: "workflow",
    title: `Fake ${id}`,
    plan: {},
    state: {},
    cursor: 0,
    total: 1,
    status: "queued",
    error: null,
    parentJobId: null,
    parkedReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function memoryQueue(jobs: Job[], starters: ReadonlyMap<string, RowStarter>): JobQueueDeps {
  fakes.unfinishedJobs.mockImplementation(() => jobs);
  fakes.getJob.mockImplementation((_db: unknown, id: string) => {
    const job = jobs.find((candidate) => candidate.id === id);
    if (!job) throw new Error(`Missing fake job ${id}`);
    return job;
  });
  fakes.setJobStatus.mockImplementation((_db: unknown, id: string, status: string, error: string | null) => {
    const job = jobs.find((candidate) => candidate.id === id);
    if (!job) throw new Error(`Missing fake job ${id}`);
    job.status = status;
    job.error = error;
  });
  return {
    state: createJobQueueState(),
    rooms: { current: () => ({ db: {} as never, path: "mem://queue" }) },
    sink: { emit: vi.fn() },
    cancelState: createCancelState(),
    starters,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("pump", () => {
  it("leaves an in-memory queue alone when no room is active", async () => {
    const deps: JobQueueDeps = {
      state: createJobQueueState(),
      rooms: { current: () => null },
      sink: { emit: vi.fn() },
      cancelState: createCancelState(),
      starters: new Map(),
    };

    await expect(pump(deps)).resolves.toBeUndefined();

    expect(fakes.unfinishedJobs).not.toHaveBeenCalled();
  });

  it("starts queued fake rows in order until a durable runner owns the slot", async () => {
    const first = queuedJob("first");
    const second = queuedJob("second");
    const started: string[] = [];
    const starter: RowStarter = async (_deps, job) => {
      started.push(job.id);
      if (job.id === first.id) {
        first.status = "done";
        return { kind: "immediate" };
      }
      return { kind: "runner" };
    };
    const deps = memoryQueue([first, second], new Map([["workflow", starter]]));

    await pump(deps);

    expect(started).toEqual(["first", "second"]);
    expect(deps.state.runningJob).toBe("second");
    expect(deps.cancelState.jobCancels.has("first")).toBe(false);
    expect(deps.cancelState.jobCancels.has("second")).toBe(true);
  });

  it("stops one pass when a broken immediate starter leaves the same fake row queued", async () => {
    const job = queuedJob("still-queued");
    const starter = vi.fn<RowStarter>().mockResolvedValue({ kind: "immediate" });
    const deps = memoryQueue([job], new Map([["workflow", starter]]));

    await pump(deps);

    expect(starter).toHaveBeenCalledTimes(1);
    expect(job.status).toBe("queued");
    expect(deps.state.runningJob).toBeNull();
  });

  it("does not overwrite a slot a concurrent fake caller reserves after queue selection", async () => {
    let reads = 0;
    const racingState = {
      get runningJob(): string | null {
        reads += 1;
        return reads === 1 ? null : "other-fake-job";
      },
      set runningJob(_value: string | null) {},
    };
    const job = queuedJob("queued-job");
    const deps = memoryQueue([job], new Map());
    deps.state = racingState;

    await pump(deps);

    expect(fakes.getJob).not.toHaveBeenCalled();
    expect(deps.cancelState.jobCancels).toEqual(new Map());
  });

  it("marks a failed fake start as error and frees the queue slot", async () => {
    const job = queuedJob("poisoned");
    const failure = "fabricated row starter failure";
    const starter: RowStarter = async () => ({ kind: "error", message: failure });
    const deps = memoryQueue([job], new Map([["workflow", starter]]));

    await pump(deps);

    expect(job).toMatchObject({ status: "error", error: failure });
    expect(deps.state.runningJob).toBeNull();
    expect(deps.cancelState.jobCancels.has(job.id)).toBe(false);
  });

  it("stops after a poisoned row cannot be marked, avoiding a tight retry loop", async () => {
    const job = queuedJob("unwritable-poison");
    const starter: RowStarter = async () => ({ kind: "error", message: "fabricated failure" });
    const deps = memoryQueue([job], new Map([["workflow", starter]]));
    fakes.setJobStatus.mockImplementation(() => {
      throw new Error("fabricated read-only room");
    });

    await pump(deps);

    expect(job.status).toBe("queued");
    expect(deps.state.runningJob).toBeNull();
    expect(deps.cancelState.jobCancels.has(job.id)).toBe(false);
    expect(fakes.setJobStatus).toHaveBeenCalledOnce();
  });
});
