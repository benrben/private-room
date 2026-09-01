import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";

const controller = vi.hoisted(() => ({
  approve: vi.fn(),
  capabilities: vi.fn(),
  cancel: vi.fn(),
  cleanupAbandoned: vi.fn(),
  listHistory: vi.fn(),
  rollback: vi.fn(),
  restoreBaselineAsCopies: vi.fn(),
  start: vi.fn(),
  stopAll: vi.fn(),
  stopAllNoWait: vi.fn(),
  approveCloudWriteback: vi.fn(),
}));

vi.mock("./harness/controller.js", () => ({
  HarnessController: class {
    approve = controller.approve;
    approveCloudWriteback = controller.approveCloudWriteback;
    capabilities = controller.capabilities;
    cancel = controller.cancel;
    cleanupAbandoned = controller.cleanupAbandoned;
    listHistory = controller.listHistory;
    rollback = controller.rollback;
    restoreBaselineAsCopies = controller.restoreBaselineAsCopies;
    start = controller.start;
    stopAll = controller.stopAll;
    stopAllNoWait = controller.stopAllNoWait;
  },
}));

import { registerHarnessSurfaceIpc } from "./harnessSurfaceIpc.js";

type Handler = (event: IpcMainInvokeEvent, args: unknown) => unknown;

function fixture(): { deps: RoomManagerDeps; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const deps = { spawnRoomServerIfEnabled: () => undefined } as RoomManagerDeps;
  registerHarnessSurfaceIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as Pick<IpcMain, "handle">,
    {} as RoomManagerState,
    deps,
    "/fake/user-data",
    vi.fn() as EventSender,
  );
  return { deps, handlers };
}

function handler(handlers: Map<string, Handler>, channel: string): Handler {
  const registered = handlers.get(channel);
  if (!registered) throw new Error(`Missing ${channel}`);
  return registered;
}

beforeEach(() => {
  vi.clearAllMocks();
  controller.approve.mockResolvedValue(undefined);
  controller.cleanupAbandoned.mockResolvedValue(undefined);
});

describe("harness approval IPC with a fabricated controller", () => {
  it("forwards a validated cloud-writeback decision", () => {
    const { handlers } = fixture();
    const writeback = handler(handlers, "harness_cloud_writeback");

    expect(writeback({} as IpcMainInvokeEvent, { runId: "run-1", approved: true }))
      .toBeUndefined();
    expect(controller.approveCloudWriteback).toHaveBeenCalledWith("run-1", true);
  });

  it("forwards every allowed decision with validated identifiers", async () => {
    const { handlers } = fixture();
    const approve = handler(handlers, "harness_approve");

    for (const decision of ["allow-once", "allow-run", "deny", "cancel"] as const) {
      await expect(approve({} as IpcMainInvokeEvent, {
        decision,
        runId: "run-1",
        requestId: "approval-1",
      })).resolves.toBeUndefined();
    }

    expect(controller.approve.mock.calls).toEqual([
      ["run-1", "approval-1", "allow-once"],
      ["run-1", "approval-1", "allow-run"],
      ["run-1", "approval-1", "deny"],
      ["run-1", "approval-1", "cancel"],
    ]);
  });

  it("rejects unknown decisions and malformed approval identifiers before the controller", () => {
    const { handlers } = fixture();
    const approve = handler(handlers, "harness_approve");

    expect(() => approve({} as IpcMainInvokeEvent, {
      decision: "always",
      runId: "run-1",
      requestId: "approval-1",
    })).toThrow("The harness approval decision is invalid.");
    expect(() => approve({} as IpcMainInvokeEvent, {
      decision: "allow-once",
      runId: " ",
      requestId: "approval-1",
    })).toThrow("runId must be a non-empty string.");
    expect(() => approve({} as IpcMainInvokeEvent, {
      decision: "deny",
      runId: "run-1",
      requestId: 1,
    })).toThrow("requestId must be a non-empty string.");
    expect(controller.approve).not.toHaveBeenCalled();
  });

  it("forwards a fabricated baseline-copy request with every relative path", async () => {
    const { handlers } = fixture();
    const restore = handler(handlers, "harness_restore_baseline_copies");
    controller.restoreBaselineAsCopies.mockResolvedValue([{ from: "baseline.md", to: "baseline (restored).md" }]);

    await expect(restore({} as IpcMainInvokeEvent, {
      runId: "run-fabricated",
      relativePaths: ["notes/brief.md", "images/chart.png"],
    })).resolves.toEqual([{ from: "baseline.md", to: "baseline (restored).md" }]);
    expect(controller.restoreBaselineAsCopies).toHaveBeenCalledExactlyOnceWith(
      "run-fabricated",
      ["notes/brief.md", "images/chart.png"],
    );
  });

  it.each([
    [{ runId: "run-1", relativePaths: "notes/brief.md" }, "relativePaths must be a list of strings."],
    [{ runId: "run-1", relativePaths: ["notes/brief.md", 4] }, "relativePaths must be a list of strings."],
    [{ runId: " ", relativePaths: [] }, "runId must be a non-empty string."],
  ])("rejects malformed fabricated baseline-copy input before the controller", (args, error) => {
    const { handlers } = fixture();
    const restore = handler(handlers, "harness_restore_baseline_copies");

    expect(() => restore({} as IpcMainInvokeEvent, args)).toThrow(error);
    expect(controller.restoreBaselineAsCopies).not.toHaveBeenCalled();
  });

  it("preserves a fabricated restore error from the controller", async () => {
    const { handlers } = fixture();
    const restore = handler(handlers, "harness_restore_baseline_copies");
    controller.restoreBaselineAsCopies.mockRejectedValueOnce(new Error("fabricated restore failure"));

    await expect(restore({} as IpcMainInvokeEvent, {
      runId: "run-1",
      relativePaths: ["notes/brief.md"],
    })).rejects.toThrow("fabricated restore failure");
  });
});
