import type Database from "better-sqlite3-multiple-ciphers";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowStore = vi.hoisted(() => ({
  dueSchedules: vi.fn(),
  markScheduleRun: vi.fn(),
  setScheduleNextRun: vi.fn(),
}));

vi.mock("./db-host/workflows.js", () => workflowStore);

import type { Schedule, Workflow } from "./db-host/workflows.js";
import {
  catchUpPass,
  createSchedulerState,
  nextRunAfter,
  spawnWorkflowScheduler,
  tick,
  type SchedulerDeps,
} from "./jobScheduler.js";

const fakeDb = {} as Database.Database;

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "schedule-1",
    workflowId: "workflow-1",
    kind: "interval",
    param: "30",
    enabled: true,
    catchUp: true,
    nextRunAt: "2000-01-01T00:00:00Z",
    lastRunAt: null,
    lastJobId: null,
    ...overrides,
  };
}

function workflow(): Workflow {
  return {
    id: "workflow-1",
    name: "Fixture workflow",
    description: "",
    emoji: "",
    definition: {},
    status: "active",
    createdBy: "fixture",
    binding: {},
    pinned: false,
    createdAt: "2000-01-01T00:00:00Z",
    updatedAt: "2000-01-01T00:00:00Z",
  };
}

function fakeDeps(startWorkflowRun: SchedulerDeps["startWorkflowRun"]): SchedulerDeps {
  return {
    rooms: { current: () => ({ db: fakeDb, path: "fixture-room" }) },
    startWorkflowRun,
  };
}

describe("tick with fake scheduler dependencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a started fake run and advances its schedule", async () => {
    const due = schedule();
    workflowStore.dueSchedules.mockReturnValue([[due, workflow()]]);
    const startWorkflowRun = vi.fn().mockResolvedValue("job-1");

    await tick(fakeDeps(startWorkflowRun), createSchedulerState(), 0, "1999-01-01T00:00:00Z");

    expect(startWorkflowRun).toHaveBeenCalledWith("workflow-1", "schedule", null);
    expect(workflowStore.markScheduleRun).toHaveBeenCalledWith(fakeDb, "schedule-1", "job-1", expect.any(String));
    expect(workflowStore.setScheduleNextRun).not.toHaveBeenCalled();
  });

  it("refuses a daily run computed from an invalid reference instant", () => {
    expect(nextRunAfter("daily", "08:00", new Date(Number.NaN))).toBeNull();
  });

  it("advances a skipped start without recording a phantom job", async () => {
    const due = schedule();
    workflowStore.dueSchedules.mockReturnValue([[due, workflow()]]);

    await tick(fakeDeps(async () => ""), createSchedulerState(), 0, "1999-01-01T00:00:00Z");

    expect(workflowStore.markScheduleRun).not.toHaveBeenCalled();
    expect(workflowStore.setScheduleNextRun).toHaveBeenCalledWith(fakeDb, "schedule-1", expect.any(String));
  });

  it("advances a rejected start without letting a broken workflow retry every tick", async () => {
    const due = schedule();
    workflowStore.dueSchedules.mockReturnValue([[due, workflow()]]);

    await tick(
      fakeDeps(async () => Promise.reject(new Error("fixture start failure"))),
      createSchedulerState(),
      0,
      "1999-01-01T00:00:00Z",
    );

    expect(workflowStore.markScheduleRun).not.toHaveBeenCalled();
    expect(workflowStore.setScheduleNextRun).toHaveBeenCalledWith(fakeDb, "schedule-1", expect.any(String));
  });

  it("skips a missed non-catch-up schedule without invoking the job starter", async () => {
    const due = schedule({ catchUp: false, nextRunAt: "2026-08-18T08:00:00Z" });
    workflowStore.dueSchedules.mockReturnValue([[due, workflow()]]);
    const startWorkflowRun = vi.fn().mockResolvedValue("job-1");

    await tick(fakeDeps(startWorkflowRun), createSchedulerState(), 0, "2026-08-18T09:59:30Z");

    expect(startWorkflowRun).not.toHaveBeenCalled();
    expect(workflowStore.setScheduleNextRun).toHaveBeenCalledWith(fakeDb, "schedule-1", expect.any(String));
  });

  it("does not persist after the fake room closes while its run starts", async () => {
    const due = schedule();
    workflowStore.dueSchedules.mockReturnValue([[due, workflow()]]);
    let open = true;
    const deps: SchedulerDeps = {
      rooms: { current: () => open ? { db: fakeDb, path: "fixture-room" } : null },
      startWorkflowRun: async () => {
        open = false;
        return "job-1";
      },
    };

    await tick(deps, createSchedulerState(), 0, "1999-01-01T00:00:00Z");

    expect(workflowStore.markScheduleRun).not.toHaveBeenCalled();
    expect(workflowStore.setScheduleNextRun).not.toHaveBeenCalled();
  });

  it("does not start a due run when the room closes after the due-list read", async () => {
    workflowStore.dueSchedules.mockReturnValue([[schedule(), workflow()]]);
    let reads = 0;
    const startWorkflowRun = vi.fn();
    const deps: SchedulerDeps = {
      rooms: { current: () => (++reads === 1 ? { db: fakeDb, path: "fixture-room" } : null) },
      startWorkflowRun,
    };
    await expect(tick(deps, createSchedulerState(), 0, "1999-01-01T00:00:00Z")).resolves.toBeUndefined();
    expect(startWorkflowRun).not.toHaveBeenCalled();
  });

  it("tolerates a room closing before a missed schedule can advance", async () => {
    const due = schedule({ catchUp: false, nextRunAt: "2026-08-18T08:00:00Z" });
    workflowStore.dueSchedules.mockReturnValue([[due, workflow()]]);
    let reads = 0;
    const deps: SchedulerDeps = {
      rooms: { current: () => (++reads === 1 ? { db: fakeDb, path: "fixture-room" } : null) },
      startWorkflowRun: vi.fn(),
    };
    await expect(tick(deps, createSchedulerState(), 0, "2026-08-18T09:59:30Z")).resolves.toBeUndefined();
    expect(workflowStore.setScheduleNextRun).not.toHaveBeenCalled();
  });

  it("contains best-effort schedule write failures", async () => {
    workflowStore.dueSchedules.mockReturnValue([[schedule(), workflow()]]);
    workflowStore.markScheduleRun.mockImplementation(() => { throw new Error("fabricated mark failure"); });
    await expect(tick(
      fakeDeps(async () => "job-1"),
      createSchedulerState(),
      0,
      "1999-01-01T00:00:00Z",
    )).resolves.toBeUndefined();

    vi.clearAllMocks();
    workflowStore.dueSchedules.mockReturnValue([[
      schedule({ catchUp: false, nextRunAt: "2026-08-18T08:00:00Z" }),
      workflow(),
    ]]);
    workflowStore.setScheduleNextRun.mockImplementation(() => { throw new Error("fabricated advance failure"); });
    await expect(tick(
      fakeDeps(vi.fn()),
      createSchedulerState(),
      0,
      "2026-08-18T09:59:30Z",
    )).resolves.toBeUndefined();
  });

  it("treats a due-schedule read failure as an empty ordinary tick", async () => {
    workflowStore.dueSchedules.mockImplementation(() => { throw new Error("fabricated read failure"); });
    await expect(tick(
      fakeDeps(vi.fn()),
      createSchedulerState(),
      0,
      "1999-01-01T00:00:00Z",
    )).resolves.toBeUndefined();
  });

  it("retires a spawned loop immediately when its tick changes generation", async () => {
    const state = createSchedulerState();
    workflowStore.dueSchedules
      .mockReturnValueOnce([])
      .mockReturnValueOnce([[schedule(), workflow()]]);
    const deps = fakeDeps(async () => {
      state.generation += 1;
      return "job-1";
    });
    const generation = spawnWorkflowScheduler(deps, state, 60_000);
    expect(generation).toBe(1);
    for (let i = 0; i < 10 && state.generation === generation; i++) await Promise.resolve();
    expect(state.generation).toBe(2);
  });

  it("arms the injected short tick interval after an ordinary empty pass", async () => {
    vi.useFakeTimers();
    try {
      workflowStore.dueSchedules.mockReturnValue([]);
      const state = createSchedulerState();
      const generation = spawnWorkflowScheduler(fakeDeps(vi.fn()), state, 1);
      for (let i = 0; i < 20 && vi.getTimerCount() === 0; i++) await Promise.resolve();

      expect(vi.getTimerCount()).toBe(1);
      state.generation = generation + 1;
      await vi.runAllTimersAsync();
      expect(workflowStore.dueSchedules).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("catchUpPass with fake scheduler dependencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires only opted-in fabricated schedules and advances opted-out schedules", async () => {
    const optedIn = schedule({ id: "schedule-catchup", workflowId: "workflow-catchup", catchUp: true });
    const optedOut = schedule({ id: "schedule-skip", workflowId: "workflow-skip", catchUp: false });
    const startWorkflowRun = vi.fn().mockResolvedValue("job-catchup");
    workflowStore.dueSchedules.mockReturnValue([
      [optedIn, { ...workflow(), id: "workflow-catchup" }],
      [optedOut, { ...workflow(), id: "workflow-skip" }],
    ]);
    const state = createSchedulerState();

    await catchUpPass(fakeDeps(startWorkflowRun), state, state.generation);

    expect(startWorkflowRun).toHaveBeenCalledExactlyOnceWith("workflow-catchup", "catchup", null);
    expect(workflowStore.markScheduleRun).toHaveBeenCalledWith(
      fakeDb,
      "schedule-catchup",
      "job-catchup",
      expect.any(String),
    );
    expect(workflowStore.setScheduleNextRun).toHaveBeenCalledWith(fakeDb, "schedule-skip", expect.any(String));
  });

  it("treats a fabricated due-schedule read failure as an empty catch-up pass", async () => {
    workflowStore.dueSchedules.mockImplementation(() => {
      throw new Error("fabricated schedule read failure");
    });
    const startWorkflowRun = vi.fn();
    const state = createSchedulerState();

    await expect(catchUpPass(fakeDeps(startWorkflowRun), state, state.generation)).resolves.toBeUndefined();

    expect(startWorkflowRun).not.toHaveBeenCalled();
    expect(workflowStore.markScheduleRun).not.toHaveBeenCalled();
    expect(workflowStore.setScheduleNextRun).not.toHaveBeenCalled();
  });

  it("does not read schedules when the fabricated room is closed", async () => {
    const state = createSchedulerState();
    const deps: SchedulerDeps = {
      rooms: { current: () => null },
      startWorkflowRun: vi.fn(),
    };

    await expect(catchUpPass(deps, state, state.generation)).resolves.toBeUndefined();

    expect(workflowStore.dueSchedules).not.toHaveBeenCalled();
  });

  it("stops before firing a fabricated overdue schedule after its generation becomes stale", async () => {
    workflowStore.dueSchedules.mockReturnValue([[schedule(), workflow()]]);
    const startWorkflowRun = vi.fn();
    const state = createSchedulerState();
    state.generation = 1;

    await catchUpPass(fakeDeps(startWorkflowRun), state, 0);

    expect(startWorkflowRun).not.toHaveBeenCalled();
    expect(workflowStore.markScheduleRun).not.toHaveBeenCalled();
    expect(workflowStore.setScheduleNextRun).not.toHaveBeenCalled();
  });
});
