import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  markJobsParking: vi.fn(),
  writeRecovery: vi.fn(),
}));

vi.mock("./db-host/recovery.js", () => ({
  hasRecovery: vi.fn(),
  recoverPassword: vi.fn(),
  writeRecovery: fakes.writeRecovery,
}));
vi.mock("./jobs.js", () => ({
  markJobsParking: fakes.markJobsParking,
  parkRunningJobs: vi.fn(),
  PARKED_BY_LOCK: "room locked",
  quiesceStaleJobs: vi.fn(),
}));

import {
  createRoomManagerState,
  drainInflight,
  writeRecoveryKey,
  type RoomManagerState,
} from "./roomManager.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function fabricatedOpenState(): RoomManagerState {
  const state = createRoomManagerState();
  state.room = {
    conn: { tag: "fabricated-db" },
    path: "/fabricated/current.roomai",
    name: "Fabricated room",
    password: "fabricated password",
  } as never;
  return state;
}

describe("room manager best-effort failure boundaries", () => {
  it("humanizes a recovery write rejection without losing the original error", async () => {
    const state = fabricatedOpenState();
    const refusal = new Error("fabricated recovery refusal");
    fakes.writeRecovery.mockRejectedValue(refusal);

    await expect(writeRecoveryKey(state)).rejects.toBe(refusal);
    expect(fakes.writeRecovery).toHaveBeenCalledWith(
      "/fabricated/current.roomai",
      "fabricated password",
    );
  });

  it("refuses recovery writes for a read-only room before storage is touched", async () => {
    const state = fabricatedOpenState();
    state.room!.readOnly = true;

    await expect(writeRecoveryKey(state)).rejects.toThrow(/read-only/i);
    expect(fakes.writeRecovery).not.toHaveBeenCalled();
  });

  it("continues an empty drain when parking running jobs fails", async () => {
    const state = fabricatedOpenState();
    fakes.markJobsParking.mockImplementation(() => {
      throw new Error("fabricated closing database");
    });

    await expect(
      drainInflight(
        state,
        {
          stopRecordingAndWait: vi.fn().mockResolvedValue(undefined),
          stopHarnessRuns: vi.fn().mockResolvedValue(undefined),
        } as never,
        { askPollMs: 1, askMaxPolls: 1, jobPollMs: 1, jobMaxPolls: 1 },
      ),
    ).resolves.toEqual({ asksDrained: true, jobsDrained: true });
    expect(fakes.markJobsParking).toHaveBeenCalledWith(state.room?.conn, "room locked");
  });
});
