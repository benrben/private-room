import { afterEach, describe, expect, it, vi } from "vitest";

import { HarnessController } from "./controller.js";

interface ShutdownHarness {
  orchestrator: {
    activeRunIds(): string[];
    cancel(runId: string): Promise<void>;
  } | null;
  pendingMirrorApprovals: Map<string, { resolve(approved: boolean): void }>;
  pendingSafetyApprovals: Map<string, { resolve(approved: boolean): void }>;
  pumps: Map<string, Promise<void>>;
  runRoots: Map<string, string>;
  removeRunRuntime(runId: string): Promise<void>;
  stopAll(timeoutMs?: number): Promise<void>;
  stopAllNoWait(): void;
}

function shutdownHarness(): ShutdownHarness {
  return Object.create(HarnessController.prototype) as ShutdownHarness;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HarnessController shutdown", () => {
  it("waits for fabricated pumps while settling cancellation and runtime cleanup failures", async () => {
    vi.useFakeTimers();
    const mirrorApproval = vi.fn();
    const safetyApproval = vi.fn();
    const cancel = vi.fn(async (runId: string) => {
      if (runId === "run-2") throw new Error("fabricated cancellation failure");
    });
    const removeRunRuntime = vi.fn(async (runId: string) => {
      if (runId === "run-2") throw new Error("fabricated cleanup failure");
    });
    const controller = shutdownHarness();
    controller.orchestrator = { activeRunIds: () => ["run-1", "run-2"], cancel };
    controller.pendingMirrorApprovals = new Map([["run-1", { resolve: mirrorApproval }]]);
    controller.pendingSafetyApprovals = new Map([["run-1", { resolve: safetyApproval }]]);
    controller.pumps = new Map([
      ["run-1", Promise.resolve()],
      ["run-2", Promise.reject(new Error("fabricated pump failure"))],
    ]);
    controller.runRoots = new Map([["run-1", "/fake/run-1"], ["run-2", "/fake/run-2"]]);
    controller.removeRunRuntime = removeRunRuntime;

    await expect(controller.stopAll()).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledTimes(2);
    expect(mirrorApproval).toHaveBeenCalledWith(false);
    expect(safetyApproval).toHaveBeenCalledWith(false);
    expect(removeRunRuntime).toHaveBeenCalledWith("run-1");
    expect(removeRunRuntime).toHaveBeenCalledWith("run-2");
  });

  it("has no work to await when every fabricated shutdown collection is empty", async () => {
    const controller = shutdownHarness();
    controller.orchestrator = null;
    controller.pendingMirrorApprovals = new Map();
    controller.pendingSafetyApprovals = new Map();
    controller.pumps = new Map();
    controller.runRoots = new Map();
    controller.removeRunRuntime = vi.fn(async () => undefined);

    await expect(controller.stopAll()).resolves.toBeUndefined();
    expect(controller.removeRunRuntime).not.toHaveBeenCalled();
  });

  it("signals fabricated approvals and schedules no-wait cleanup without surfacing failures", async () => {
    const mirrorApproval = vi.fn();
    const safetyApproval = vi.fn();
    const cancel = vi.fn((runId: string) => {
      if (runId === "run-1") return Promise.reject(new Error("fabricated cancellation failure"));
      return Promise.resolve();
    });
    const removeRunRuntime = vi.fn((runId: string) => {
      if (runId === "run-2") return Promise.reject(new Error("fabricated cleanup failure"));
      return Promise.resolve();
    });
    const controller = shutdownHarness();
    controller.orchestrator = { activeRunIds: () => ["run-1", "run-2"], cancel };
    controller.pendingMirrorApprovals = new Map([["run-1", { resolve: mirrorApproval }]]);
    controller.pendingSafetyApprovals = new Map([["run-2", { resolve: safetyApproval }]]);
    controller.pumps = new Map();
    controller.runRoots = new Map([["run-1", "/fake/run-1"], ["run-2", "/fake/run-2"]]);
    controller.removeRunRuntime = removeRunRuntime;

    controller.stopAllNoWait();
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledWith("run-1");
    expect(cancel).toHaveBeenCalledWith("run-2");
    expect(mirrorApproval).toHaveBeenCalledWith(false);
    expect(safetyApproval).toHaveBeenCalledWith(false);
    expect(removeRunRuntime).toHaveBeenCalledWith("run-1");
    expect(removeRunRuntime).toHaveBeenCalledWith("run-2");
  });
});
