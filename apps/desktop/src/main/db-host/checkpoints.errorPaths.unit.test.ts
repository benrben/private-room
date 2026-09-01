import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  chmodSync: vi.fn(),
  copyFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  renameSync: vi.fn(),
  statfsSync: vi.fn(),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("node:fs", () => fake);

import { reconcile, writeCheckpoint } from "./checkpoints.js";

beforeEach(() => vi.clearAllMocks());

describe("checkpoint filesystem races", () => {
  it("keeps the last known size when a payload disappears and tolerates an unreadable directory", () => {
    fake.existsSync.mockReturnValue(true);
    fake.readFileSync.mockReturnValue(JSON.stringify({
      v: 1,
      entries: [{
        id: "checkpoint-1",
        name: "Before edit",
        createdAt: "2026-01-01T00:00:00Z",
        sizeBytes: 42,
        auto: false,
      }],
    }));
    fake.statSync.mockImplementation(() => { throw new Error("fabricated stat race"); });
    fake.readdirSync.mockImplementation(() => { throw new Error("fabricated directory failure"); });

    expect(reconcile("/fabricated/checkpoints").entries).toEqual([
      expect.objectContaining({ id: "checkpoint-1", sizeBytes: 42 }),
    ]);
  });

  it("removes a completed temporary copy when publishing it fails", () => {
    fake.existsSync.mockReturnValue(false);
    fake.readdirSync.mockReturnValue([]);
    fake.statfsSync.mockReturnValue({ bsize: 4096, bavail: 1_000_000 });
    fake.renameSync.mockImplementation((from: string, to: string) => {
      if (from.endsWith(".tmp") && to.endsWith(".roomck")) {
        throw new Error("fabricated rename failure");
      }
    });
    const db = {
      pragma: vi.fn(() => 1),
      exec: vi.fn(),
    };

    expect(() => writeCheckpoint(
      db as never,
      "/fabricated/checkpoints",
      "Before edit",
      false,
    )).toThrow("Could not save the checkpoint: fabricated rename failure");
    expect(fake.unlinkSync).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/));
  });
});
