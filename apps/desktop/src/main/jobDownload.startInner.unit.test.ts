import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  atCapacity: vi.fn(),
  checkPublicHttpUrl: vi.fn(),
  createJob: vi.fn(),
  runnerDepsFrom: vi.fn(),
  spawnJobRunner: vi.fn(),
  tryReserve: vi.fn(),
  webAccessEnabled: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ rm: vi.fn() }));
vi.mock("./cancel.js", () => ({
  CancelFlag: class CancelFlag {
    load() {
      return false;
    }
  },
}));
vi.mock("./browser/guard.js", () => ({ checkPublicHttpUrl: mocks.checkPublicHttpUrl }));
vi.mock("./browser/webAccess.js", () => ({ webAccessEnabled: mocks.webAccessEnabled }));
vi.mock("./db-host/jobs.js", () => ({ createJob: mocks.createJob, setJobStatus: vi.fn() }));
vi.mock("./jobs.js", () => ({
  emitProgress: vi.fn(),
  pinnedDb: vi.fn(),
  spawnJobRunner: mocks.spawnJobRunner,
}));
vi.mock("./jobQueue.js", () => ({
  atCapacity: mocks.atCapacity,
  QUEUE_FULL: "fabricated queue full",
  runnerDepsFrom: mocks.runnerDepsFrom,
  tryReserve: mocks.tryReserve,
  UNREADABLE_PLAN: "unreadable plan",
}));
vi.mock("./ytdlp.js", () => ({
  downloadMediaToTemp: vi.fn(),
  MAX_DOWNLOAD_BYTES: 1_000,
  WEB_OFF_MESSAGE: "fabricated web access is off",
}));

import {
  DOWNLOAD_ENGINE_FETCH,
  DOWNLOAD_ENGINE_MEDIA,
  planString,
  startDownloadJobInner,
} from "./jobDownload.js";

const fakeRoom = { db: { fake: true }, path: "/fake-room" };

function dependencies(current: () => typeof fakeRoom | null = () => fakeRoom) {
  return {
    cancelState: { jobCancels: new Map() },
    dataDir: "/fake-data",
    importDownload: vi.fn(),
    rooms: { current },
    sink: { emit: vi.fn() },
    starters: new Map(),
    state: { runningJob: null },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.atCapacity.mockReturnValue(false);
  mocks.createJob.mockReturnValue("download-job-1");
  mocks.runnerDepsFrom.mockReturnValue({ onSettled: vi.fn(), removeCancelFlag: vi.fn() });
  mocks.spawnJobRunner.mockResolvedValue(undefined);
  mocks.tryReserve.mockReturnValue(false);
  mocks.webAccessEnabled.mockReturnValue(true);
});

describe("startDownloadJobInner with fabricated queue and HTTP boundaries", () => {
  it("reads only fabricated string fields from persisted download plans", () => {
    expect(planString({ url: "https://files.example/report.pdf", empty: "" }, "url")).toBe(
      "https://files.example/report.pdf",
    );
    expect(planString({ url: "https://files.example/report.pdf", empty: "" }, "empty")).toBe("");
    for (const plan of [null, [], "not a plan", 7, { url: 7 }, {}]) {
      expect(planString(plan, "url")).toBeNull();
    }
  });

  it("rejects an unknown engine before consulting room, web, or queue state", () => {
    const deps = dependencies();

    expect(() => startDownloadJobInner(deps as Parameters<typeof startDownloadJobInner>[0], "https://files.example/a", "other")).toThrow(
      "Unknown download engine.",
    );
    expect(mocks.webAccessEnabled).not.toHaveBeenCalled();
    expect(mocks.checkPublicHttpUrl).not.toHaveBeenCalled();
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it("refuses a closed room before the public URL guard", () => {
    const deps = dependencies(() => null);

    expect(() => startDownloadJobInner(deps as Parameters<typeof startDownloadJobInner>[0], "https://files.example/a", DOWNLOAD_ENGINE_MEDIA)).toThrow(
      "No room is open.",
    );
    expect(mocks.webAccessEnabled).not.toHaveBeenCalled();
    expect(mocks.checkPublicHttpUrl).not.toHaveBeenCalled();
  });

  it("checks the room's web setting before its fabricated URL guard", () => {
    mocks.webAccessEnabled.mockReturnValue(false);
    const deps = dependencies();

    expect(() => startDownloadJobInner(deps as Parameters<typeof startDownloadJobInner>[0], "not even a URL", DOWNLOAD_ENGINE_MEDIA)).toThrow(
      "fabricated web access is off",
    );
    expect(mocks.checkPublicHttpUrl).not.toHaveBeenCalled();
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it("propagates a fabricated URL refusal before it writes a job row", () => {
    mocks.checkPublicHttpUrl.mockImplementation(() => {
      throw new Error("fabricated URL refusal");
    });
    const deps = dependencies();

    expect(() => startDownloadJobInner(deps as Parameters<typeof startDownloadJobInner>[0], "https://blocked.example/a", DOWNLOAD_ENGINE_MEDIA)).toThrow(
      "fabricated URL refusal",
    );
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it("checks capacity after the second room read and before creating a row", () => {
    mocks.atCapacity.mockReturnValue(true);
    const deps = dependencies();

    expect(() => startDownloadJobInner(deps as Parameters<typeof startDownloadJobInner>[0], "https://files.example/a", DOWNLOAD_ENGINE_MEDIA)).toThrow(
      "fabricated queue full",
    );
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it("refuses if the room closes after the web check but before job creation", () => {
    const current = vi.fn().mockReturnValueOnce(fakeRoom).mockReturnValueOnce(null);
    const deps = dependencies(current);

    expect(() => startDownloadJobInner(deps as Parameters<typeof startDownloadJobInner>[0], "https://files.example/a", DOWNLOAD_ENGINE_MEDIA)).toThrow(
      "No room is open.",
    );
    expect(mocks.checkPublicHttpUrl).toHaveBeenCalledOnce();
    expect(mocks.createJob).not.toHaveBeenCalled();
  });

  it("keeps a fabricated download queued when no queue slot is available", () => {
    const deps = dependencies();

    const jobId = startDownloadJobInner(
      deps as Parameters<typeof startDownloadJobInner>[0],
      "https://files.example/report.pdf",
      DOWNLOAD_ENGINE_FETCH,
    );

    expect(jobId).toBe("download-job-1");
    expect(mocks.createJob).toHaveBeenCalledWith(
      fakeRoom.db,
      "download",
      "Download report.pdf",
      { url: "https://files.example/report.pdf", engine: DOWNLOAD_ENGINE_FETCH },
      0,
    );
    expect(deps.cancelState.jobCancels.size).toBe(0);
    expect(mocks.spawnJobRunner).not.toHaveBeenCalled();
  });

  it("reserves the fabricated slot, registers cancellation, and starts a fake runner", () => {
    mocks.tryReserve.mockReturnValue(true);
    const deps = dependencies();

    const jobId = startDownloadJobInner(
      deps as Parameters<typeof startDownloadJobInner>[0],
      "https://media.example/watch",
      DOWNLOAD_ENGINE_MEDIA,
    );

    expect(jobId).toBe("download-job-1");
    expect(mocks.tryReserve).toHaveBeenCalledWith(deps.state, jobId);
    expect(deps.cancelState.jobCancels.has(jobId)).toBe(true);
    expect(mocks.runnerDepsFrom).toHaveBeenCalledWith(deps);
    expect(mocks.spawnJobRunner).toHaveBeenCalledWith(
      expect.objectContaining({ dataDir: "/fake-data", rooms: deps.rooms }),
      jobId,
      "/fake-room",
      expect.any(Function),
    );
  });
});
