import { describe, expect, it, vi } from "vitest";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";

const mocks = vi.hoisted(() => ({
  bestLocalDefault: vi.fn(),
  listModels: vi.fn(),
  modelSetting: vi.fn(),
  runsOnThisMac: vi.fn(),
}));

vi.mock("./db-host/jobs.js", () => ({
  deleteJob: vi.fn(), getJob: vi.fn(), getJobArtifact: vi.fn(), listJobs: vi.fn(), setJobStatus: vi.fn(),
}));
vi.mock("./db-host/workflows.js", () => ({
  createWorkflow: vi.fn(), getSchedule: vi.fn(), getWorkflow: vi.fn(), listWorkflowRuns: vi.fn(),
  listWorkflows: vi.fn(), setWorkflowStatus: vi.fn(), updateWorkflow: vi.fn(),
}));
vi.mock("./jobQueue.js", () => ({ submit: vi.fn() }));
vi.mock("./workflowRuns.js", () => ({
  deleteWorkflowCmd: vi.fn(), runWorkflowCommand: vi.fn(), setWorkflowPinnedCmd: vi.fn(),
  setWorkflowScheduleCmd: vi.fn(), setWorkflowStatusCmd: vi.fn(), startWorkflowRun: vi.fn(), workflowRowStarter: vi.fn(),
}));
vi.mock("./workflowCompose.js", () => ({
  applySchedule: vi.fn(), parseBinding: vi.fn(), parseDef: vi.fn(), validateWorkflowInner: vi.fn(),
}));
vi.mock("./scriptSurfaceIpc.js", () => ({ createScriptApprovalRequester: vi.fn() }));
vi.mock("./engineRouting.js", () => ({ listModels: mocks.listModels }));
vi.mock("./gatherContext.js", () => ({ modelSetting: mocks.modelSetting }));
vi.mock("./ollamaModels.js", () => ({ bestLocalDefault: mocks.bestLocalDefault }));
vi.mock("./capabilities.js", () => ({ runsOnThisMac: mocks.runsOnThisMac }));

import { createWorkflowRunDeps } from "./jobWorkflowSurfaceIpc.js";

function resolveEngine(state: RoomManagerState) {
  const deps = {
    jobQueue: { rooms: { current: vi.fn() } },
  } as RoomManagerDeps;
  return createWorkflowRunDeps(state, deps, "/fake/user-data", vi.fn() as EventSender).resolveEngine;
}

describe("workflow resolveEngine with fabricated model catalog dependencies", () => {
  it("refuses a closed room before touching the fake catalog", async () => {
    await expect(resolveEngine({ room: null } as RoomManagerState)()).rejects.toThrow("No room is open.");
    expect(mocks.listModels).not.toHaveBeenCalled();
  });

  it("prefers the configured model and preserves its local lane", async () => {
    const conn = { name: "fake db" };
    mocks.listModels.mockResolvedValue(["fallback-model"]);
    mocks.modelSetting.mockReturnValue("configured-model");
    mocks.runsOnThisMac.mockReturnValue(true);

    await expect(resolveEngine({ room: { conn } } as unknown as RoomManagerState)())
      .resolves.toEqual({ model: "configured-model", lane: "local_llm" });
    expect(mocks.listModels).toHaveBeenCalledOnce();
    expect(mocks.modelSetting).toHaveBeenCalledWith(conn);
    expect(mocks.bestLocalDefault).not.toHaveBeenCalled();
    expect(mocks.runsOnThisMac).toHaveBeenCalledWith("configured-model");
  });

  it("uses the fake default and cloud lane when no configured model exists", async () => {
    mocks.listModels.mockResolvedValue(["fallback-model"]);
    mocks.modelSetting.mockReturnValue(null);
    mocks.bestLocalDefault.mockReturnValue("cloud-model");
    mocks.runsOnThisMac.mockReturnValue(false);

    await expect(resolveEngine({ room: { conn: {} } } as unknown as RoomManagerState)())
      .resolves.toEqual({ model: "cloud-model", lane: "cloud" });
    expect(mocks.bestLocalDefault).toHaveBeenCalledWith(["fallback-model"]);
  });
});
