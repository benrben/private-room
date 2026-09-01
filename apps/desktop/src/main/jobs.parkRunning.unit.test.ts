import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parkJob: vi.fn(),
  setWorkflowRunStatus: vi.fn(),
  unfinishedJobs: vi.fn(),
}));

vi.mock("./db-host/jobs.js", () => ({
  dedupeParkedJobs: vi.fn(),
  getJob: vi.fn(),
  markJobParking: vi.fn(),
  parkJob: mocks.parkJob,
  pruneJobHistory: vi.fn(),
  setJobStatus: vi.fn(),
  unfinishedJobs: mocks.unfinishedJobs,
}));
vi.mock("./db-host/workflows.js", () => ({
  finishWorkflowRunByJob: vi.fn(),
  setWorkflowRunStatusByJob: mocks.setWorkflowRunStatus,
}));

import { parkRunningJobs } from "./jobs.js";

function fakeDb() {
  return { fake: "jobs-db" };
}

describe("parkRunningJobs with fabricated job and workflow persistence", () => {
  beforeEach(() => vi.resetAllMocks());

  it("parks running jobs, skips non-running rows, and survives a workflow-status cleanup failure", () => {
    const db = fakeDb();
    mocks.unfinishedJobs.mockReturnValue([
      { id: "running-one", status: "running" },
      { id: "queued", status: "queued" },
      { id: "paused", status: "paused" },
      { id: "running-two", status: "running" },
    ]);
    mocks.setWorkflowRunStatus.mockImplementation((_db: unknown, id: string) => {
      if (id === "running-two") throw new Error("fabricated workflow cleanup failure");
    });

    expect(parkRunningJobs(db as never, "fabricated shutdown")).toBe(2);
    expect(mocks.parkJob.mock.calls).toEqual([
      [db, "running-one", "fabricated shutdown"],
      [db, "running-two", "fabricated shutdown"],
    ]);
    expect(mocks.setWorkflowRunStatus.mock.calls).toEqual([
      [db, "running-one", "paused"],
      [db, "running-two", "paused"],
    ]);
  });

  it("does not count or clean up a running row whose fabricated park write fails", () => {
    const db = fakeDb();
    mocks.unfinishedJobs.mockReturnValue([
      { id: "write-failed", status: "running" },
      { id: "queued", status: "queued" },
    ]);
    mocks.parkJob.mockImplementation(() => { throw new Error("fabricated job write failure"); });

    expect(parkRunningJobs(db as never, "fabricated shutdown")).toBe(0);
    expect(mocks.parkJob).toHaveBeenCalledWith(db, "write-failed", "fabricated shutdown");
    expect(mocks.setWorkflowRunStatus).not.toHaveBeenCalled();
  });

  it("returns zero without writes when the fabricated unfinished-job read fails", () => {
    const db = fakeDb();
    mocks.unfinishedJobs.mockImplementation(() => { throw new Error("fabricated read failure"); });

    expect(parkRunningJobs(db as never, "fabricated shutdown")).toBe(0);
    expect(mocks.parkJob).not.toHaveBeenCalled();
    expect(mocks.setWorkflowRunStatus).not.toHaveBeenCalled();
  });
});
