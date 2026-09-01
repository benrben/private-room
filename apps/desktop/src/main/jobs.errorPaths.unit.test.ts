import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  dedupeParkedJobs: vi.fn(),
  finishWorkflowRunByJob: vi.fn(),
  getJob: vi.fn(),
  markJobParking: vi.fn(),
  parkJob: vi.fn(),
  pruneJobHistory: vi.fn(),
  setJobStatus: vi.fn(),
  setWorkflowRunStatusByJob: vi.fn(),
  unfinishedJobs: vi.fn(),
}));

vi.mock("./db-host/jobs.js", () => ({
  dedupeParkedJobs: fake.dedupeParkedJobs,
  getJob: fake.getJob,
  markJobParking: fake.markJobParking,
  parkJob: fake.parkJob,
  pruneJobHistory: fake.pruneJobHistory,
  setJobStatus: fake.setJobStatus,
  unfinishedJobs: fake.unfinishedJobs,
}));
vi.mock("./db-host/workflows.js", () => ({
  finishWorkflowRunByJob: fake.finishWorkflowRunByJob,
  setWorkflowRunStatusByJob: fake.setWorkflowRunStatusByJob,
}));

import { markJobsParking, parkCrashedJob, quiesceStaleJobs, spawnJobRunner } from "./jobs.js";

beforeEach(() => vi.clearAllMocks());

describe("best-effort job recovery", () => {
  const db = { marker: "db" };

  it("returns zero when running jobs cannot be read", () => {
    fake.unfinishedJobs.mockImplementation(() => { throw new Error("fabricated read failure"); });
    expect(markJobsParking(db as never, "closing")).toBe(0);
  });

  it("does not count a parking marker that could not be stored", () => {
    fake.unfinishedJobs.mockReturnValue([{ id: "job-1", status: "running" }]);
    fake.markJobParking.mockImplementation(() => { throw new Error("fabricated write failure"); });
    expect(markJobsParking(db as never, "closing")).toBe(0);
  });

  it("continues room opening when dedupe and history pruning both fail", () => {
    fake.unfinishedJobs.mockReturnValue([]);
    fake.dedupeParkedJobs.mockImplementation(() => { throw new Error("fabricated dedupe failure"); });
    fake.pruneJobHistory.mockImplementation(() => { throw new Error("fabricated prune failure"); });

    expect(() => quiesceStaleJobs(db as never)).not.toThrow();
    expect(fake.dedupeParkedJobs).toHaveBeenCalledWith(db);
    expect(fake.pruneJobHistory).toHaveBeenCalledWith(db);
  });

  it("parks a crash even when its workflow-run epilogue fails", () => {
    fake.getJob.mockReturnValue({ id: "job-1", status: "running", cursor: 2, total: 5 });
    fake.finishWorkflowRunByJob.mockImplementation(() => { throw new Error("fabricated workflow failure"); });

    expect(parkCrashedJob(db as never, "job-1", "crashed")).toEqual({ cursor: 2, total: 5 });
    expect(fake.setJobStatus).toHaveBeenCalledWith(db, "job-1", "error", "crashed");
  });

  it("settles a crashed runner even when its progress sink throws", async () => {
    fake.getJob.mockReturnValue({ id: "job-1", status: "running", cursor: 2, total: 5 });
    const settled = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(spawnJobRunner(
      {
        rooms: { current: () => ({ db, path: "/room" }) },
        sink: { emit: () => { throw new Error("fabricated renderer failure"); } },
        removeCancelFlag: vi.fn(),
        onSettled: settled,
      } as never,
      "job-1",
      "/room",
      async () => { throw new Error("fabricated runner crash"); },
    )).resolves.toBeUndefined();

    expect(settled).toHaveBeenCalledWith("job-1");
  });

  it("still releases the queue when a crashed runner's job row is unreadable", async () => {
    fake.getJob.mockImplementation(() => { throw new Error("fabricated row read failure"); });
    const emit = vi.fn();
    const removeCancelFlag = vi.fn();
    const onSettled = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(spawnJobRunner(
      {
        rooms: { current: () => ({ db, path: "/room" }) },
        sink: { emit },
        removeCancelFlag,
        onSettled,
      } as never,
      "job-1",
      "/room",
      async () => { throw new Error("fabricated runner crash"); },
    )).resolves.toBeUndefined();

    expect(emit).not.toHaveBeenCalled();
    expect(removeCancelFlag).toHaveBeenCalledWith("job-1");
    expect(onSettled).toHaveBeenCalledWith("job-1");
  });
});
