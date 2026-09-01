import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";

const mocks = vi.hoisted(() => ({
  applySchedule: vi.fn(),
  createScriptApprovalRequester: vi.fn(),
  createWorkflow: vi.fn(),
  deleteJob: vi.fn(),
  deleteWorkflowCmd: vi.fn(),
  getJobArtifact: vi.fn(),
  getSchedule: vi.fn(),
  getJob: vi.fn(),
  getWorkflow: vi.fn(),
  listJobs: vi.fn(),
  listWorkflowRuns: vi.fn(),
  listWorkflows: vi.fn(),
  parseBinding: vi.fn(),
  parseDef: vi.fn(),
  setJobStatus: vi.fn(),
  setWorkflowStatus: vi.fn(),
  setWorkflowPinnedCmd: vi.fn(),
  setWorkflowScheduleCmd: vi.fn(),
  setWorkflowStatusCmd: vi.fn(),
  startWorkflowRun: vi.fn(),
  submit: vi.fn(),
  updateWorkflow: vi.fn(),
  validateWorkflowInner: vi.fn(),
  runWorkflowCommand: vi.fn(),
  workflowRowStarter: vi.fn(),
}));

vi.mock("./db-host/jobs.js", () => ({
  deleteJob: mocks.deleteJob,
  getJob: mocks.getJob,
  getJobArtifact: mocks.getJobArtifact,
  listJobs: mocks.listJobs,
  setJobStatus: mocks.setJobStatus,
}));
vi.mock("./db-host/workflows.js", () => ({
  createWorkflow: mocks.createWorkflow,
  getSchedule: mocks.getSchedule,
  getWorkflow: mocks.getWorkflow,
  listWorkflowRuns: mocks.listWorkflowRuns,
  listWorkflows: mocks.listWorkflows,
  setWorkflowStatus: mocks.setWorkflowStatus,
  updateWorkflow: mocks.updateWorkflow,
}));
vi.mock("./jobQueue.js", () => ({ submit: mocks.submit }));
vi.mock("./workflowRuns.js", () => ({
  deleteWorkflowCmd: mocks.deleteWorkflowCmd,
  runWorkflowCommand: mocks.runWorkflowCommand,
  setWorkflowPinnedCmd: mocks.setWorkflowPinnedCmd,
  setWorkflowScheduleCmd: mocks.setWorkflowScheduleCmd,
  setWorkflowStatusCmd: mocks.setWorkflowStatusCmd,
  startWorkflowRun: mocks.startWorkflowRun,
  workflowRowStarter: mocks.workflowRowStarter,
}));
vi.mock("./workflowCompose.js", () => ({
  applySchedule: mocks.applySchedule,
  parseBinding: mocks.parseBinding,
  parseDef: mocks.parseDef,
  validateWorkflowInner: mocks.validateWorkflowInner,
}));
vi.mock("./scriptSurfaceIpc.js", () => ({ createScriptApprovalRequester: mocks.createScriptApprovalRequester }));
vi.mock("./engineRouting.js", () => ({ listModels: vi.fn() }));
vi.mock("./gatherContext.js", () => ({ modelSetting: vi.fn() }));
vi.mock("./ollamaModels.js", () => ({ bestLocalDefault: vi.fn() }));
vi.mock("./capabilities.js", () => ({ runsOnThisMac: vi.fn() }));

import { registerJobWorkflowSurfaceIpc } from "./jobWorkflowSurfaceIpc.js";

type Handler = (event: IpcMainInvokeEvent, raw?: unknown) => unknown;

function fixture(deps = {} as RoomManagerDeps): {
  deps: RoomManagerDeps;
  emit: ReturnType<typeof vi.fn>;
  handlers: Map<string, Handler>;
  state: RoomManagerState;
} {
  const handlers = new Map<string, Handler>();
  const state = {
    room: { conn: { name: "fake database" }, path: "/rooms/fake", name: "Fake" },
    rollingBack: false,
    cancel: { jobCancels: new Map() },
  } as unknown as RoomManagerState;
  const emit = vi.fn();
  registerJobWorkflowSurfaceIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as Pick<IpcMain, "handle">,
    state,
    deps,
    "/userdata",
    emit as EventSender,
  );
  return { deps, emit, handlers, state };
}

function handler(handlers: Map<string, Handler>, channel: string): Handler {
  const registered = handlers.get(channel);
  if (registered === undefined) throw new Error(`Missing ${channel}`);
  return registered;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createWorkflow.mockReturnValue("workflow-1");
  mocks.parseBinding.mockImplementation((value: unknown) => ({ binding: value }));
  mocks.parseDef.mockImplementation((value: unknown) => ({ definition: value }));
  mocks.validateWorkflowInner.mockResolvedValue([]);
  mocks.getWorkflow.mockReturnValue({
    binding: { scope: "general" },
    definition: { version: 1 },
    description: "Old description",
    emoji: "📌",
    name: "Old name",
  });
  mocks.getJob.mockReturnValue({ status: "paused" });
  mocks.createScriptApprovalRequester.mockReturnValue(vi.fn(async () => true));
  mocks.runWorkflowCommand.mockResolvedValue("fake-run-1");
  mocks.submit.mockResolvedValue(undefined);
});

describe("workflow library IPC persistence", () => {
  it("requeues paused and failed jobs with only a fabricated queue", async () => {
    const queue = {
      cancelState: { jobCancels: new Map() },
      rooms: { current: vi.fn() },
      sink: { emit: vi.fn() },
      starters: new Map(),
      state: { runningJob: null },
    } as unknown as NonNullable<RoomManagerDeps["jobQueue"]>;
    const { handlers } = fixture({ jobQueue: queue } as RoomManagerDeps);
    const resume = handler(handlers, "resume_job");
    mocks.getJob.mockReturnValueOnce({ status: "paused" }).mockReturnValueOnce({ status: "error" });

    await expect(resume({} as IpcMainInvokeEvent, { id: 42 })).resolves.toBeUndefined();
    await expect(resume({} as IpcMainInvokeEvent, { id: "failed-1" })).resolves.toBeUndefined();

    expect(mocks.getJob.mock.calls).toEqual([
      [{ name: "fake database" }, "42"],
      [{ name: "fake database" }, "failed-1"],
    ]);
    expect(mocks.setJobStatus.mock.calls).toEqual([
      [{ name: "fake database" }, "42", "queued", null],
      [{ name: "fake database" }, "failed-1", "queued", null],
    ]);
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    expect(mocks.submit.mock.calls.map(([, id]) => id)).toEqual(["42", "failed-1"]);
  });

  it("refuses active jobs and reports a missing fake queue after durable requeue", async () => {
    const withQueue = fixture({ jobQueue: {} } as RoomManagerDeps);
    mocks.getJob.mockReturnValueOnce({ status: "running" });
    await expect(handler(withQueue.handlers, "resume_job")({} as IpcMainInvokeEvent, { id: "running" }))
      .rejects.toThrow("Only a paused or failed job can be resumed.");
    expect(mocks.setJobStatus).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();

    const withoutQueue = fixture();
    mocks.getJob.mockReturnValueOnce({ status: "paused" });
    await expect(handler(withoutQueue.handlers, "resume_job")({} as IpcMainInvokeEvent, { id: "later" }))
      .rejects.toThrow("The job queue is unavailable.");
    expect(mocks.setJobStatus).toHaveBeenCalledWith({ name: "fake database" }, "later", "queued", null);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("validates, persists, schedules, then announces a new workflow with the existing defaults", async () => {
    const { emit, handlers } = fixture();
    const definition = { version: 1, nodes: [], edges: [] };
    const binding = { scope: "general" };

    await expect(handler(handlers, "save_workflow")({} as IpcMainInvokeEvent, {
      name: " ", description: 12, emoji: "", definition, createdBy: null, binding,
      schedule: { kind: "daily", param: "09:00", enabled: false, catchUp: false },
    })).resolves.toBe("workflow-1");

    expect(mocks.validateWorkflowInner).toHaveBeenCalledWith(
      { name: "fake database" }, { definition }, { binding },
    );
    expect(mocks.createWorkflow).toHaveBeenCalledWith(
      { name: "fake database" }, "New workflow", "12", "✨", definition, "user", { binding },
    );
    expect(mocks.applySchedule).toHaveBeenCalledWith(
      { name: "fake database" }, "workflow-1", { definition }, "daily", "09:00", false, false,
    );
    expect(emit).toHaveBeenCalledWith("workflows-changed", undefined);
  });

  it("preserves existing update fields, resets status, and applies an explicitly empty schedule", async () => {
    const { emit, handlers } = fixture();

    await expect(handler(handlers, "update_workflow")({} as IpcMainInvokeEvent, {
      id: 7, description: "New description", definition: 0, binding: null, schedule: null,
    })).resolves.toBeUndefined();

    expect(mocks.getWorkflow).toHaveBeenCalledWith({ name: "fake database" }, "7");
    expect(mocks.updateWorkflow).toHaveBeenCalledWith(
      { name: "fake database" }, "7", "Old name", "New description", "📌", 0, { binding: { scope: "general" } },
    );
    expect(mocks.setWorkflowStatus).toHaveBeenCalledWith({ name: "fake database" }, "7", "draft");
    expect(mocks.applySchedule).toHaveBeenCalledWith(
      { name: "fake database" }, "7", { definition: 0 }, "", "", true, true,
    );
    expect(emit).toHaveBeenCalledWith("workflows-changed", undefined);
  });

  it("leaves persistence and notifications untouched when validation fails", async () => {
    const { emit, handlers } = fixture();
    mocks.validateWorkflowInner.mockResolvedValue(["bad graph", "missing input"]);

    await expect(handler(handlers, "save_workflow")({} as IpcMainInvokeEvent, {})).rejects.toThrow(
      "bad graph; missing input",
    );

    expect(mocks.createWorkflow).not.toHaveBeenCalled();
    expect(mocks.applySchedule).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("job workflow IPC actions", () => {
  it("wires the scheduler and forwards all read and mutation handlers", async () => {
    const queue = {
      cancelState: { jobCancels: new Map() },
      rooms: { current: vi.fn() },
      sink: { emit: vi.fn() },
      starters: new Map(),
      state: { runningJob: null },
    } as unknown as NonNullable<RoomManagerDeps["jobQueue"]>;
    const scheduler = { deps: { startWorkflowRun: vi.fn() } };
    const { handlers, emit, state } = fixture({ jobQueue: queue, scheduler } as unknown as RoomManagerDeps);
    const db = state.room!.conn;
    mocks.listJobs.mockReturnValue(["job"]);
    mocks.listWorkflows.mockReturnValue(["workflow"]);
    mocks.getSchedule.mockReturnValue({ kind: "daily" });
    mocks.listWorkflowRuns.mockReturnValue(["run"]);
    mocks.getJobArtifact.mockReturnValue({ artifact: true });
    mocks.validateWorkflowInner.mockResolvedValue([]);
    mocks.startWorkflowRun.mockResolvedValue("run-from-scheduler");

    expect(handler(handlers, "list_jobs")({} as IpcMainInvokeEvent)).toEqual(["job"]);
    expect(handler(handlers, "list_workflows")({} as IpcMainInvokeEvent)).toEqual(["workflow"]);
    expect(handler(handlers, "get_workflow_schedule")({} as IpcMainInvokeEvent, { id: 7 }))
      .toEqual({ kind: "daily" });
    expect(handler(handlers, "get_workflow_runs")({} as IpcMainInvokeEvent, { id: 7 }))
      .toEqual(["run"]);
    expect(handler(handlers, "get_job_step_artifact")(
      {} as IpcMainInvokeEvent,
      { jobId: 8, stepId: "2" },
    )).toEqual({ artifact: true });
    await expect(handler(handlers, "validate_workflow")(
      {} as IpcMainInvokeEvent,
      { definition: "def", binding: "binding" },
    )).resolves.toEqual([]);

    const cancel = { store: vi.fn() };
    state.cancel.jobCancels.set("8", cancel as never);
    handler(handlers, "delete_job")({} as IpcMainInvokeEvent, { id: 8 });
    handler(handlers, "delete_workflow")({} as IpcMainInvokeEvent, { id: 9 });
    handler(handlers, "set_workflow_status")({} as IpcMainInvokeEvent, { id: 9, status: "active" });
    handler(handlers, "set_workflow_pinned")({} as IpcMainInvokeEvent, { id: 9, pinned: true });
    handler(handlers, "set_workflow_schedule")({} as IpcMainInvokeEvent, { id: 9, schedule: null });
    await expect(scheduler.deps.startWorkflowRun("wf", "daily", "input"))
      .resolves.toBe("run-from-scheduler");

    expect(cancel.store).toHaveBeenCalledWith(true);
    expect(mocks.deleteJob).toHaveBeenCalledWith(db, "8");
    expect(mocks.deleteWorkflowCmd).toHaveBeenCalledWith(db, "9", state.cancel);
    expect(mocks.setWorkflowStatusCmd).toHaveBeenCalledWith(db, "9", "active");
    expect(mocks.setWorkflowPinnedCmd).toHaveBeenCalledWith(db, "9", true);
    expect(mocks.setWorkflowScheduleCmd).toHaveBeenCalledWith(db, "9", {
      kind: "",
      param: "",
      enabled: true,
      catchUp: true,
    });
    expect(mocks.startWorkflowRun).toHaveBeenCalledWith(expect.any(Object), "wf", "daily", "input", new Set());
    expect(emit).toHaveBeenCalledTimes(4);
  });

  it("normalizes a queued job id, cancels its fabricated flag, and pauses the row", () => {
    const { handlers, state } = fixture();
    const store = vi.fn();
    state.cancel.jobCancels.set("42", { store } as never);
    mocks.getJob.mockReturnValue({ status: "queued" });

    expect(handler(handlers, "cancel_job")({} as IpcMainInvokeEvent, { id: 42 })).toBeUndefined();

    expect(mocks.getJob).toHaveBeenCalledWith({ name: "fake database" }, "42");
    expect(store).toHaveBeenCalledWith(true);
    expect(mocks.setJobStatus).toHaveBeenCalledWith({ name: "fake database" }, "42", "paused", null);
  });

  it("forwards a fabricated job lookup failure after normalizing a missing cancel payload", () => {
    const { handlers, state } = fixture();
    const store = vi.fn();
    state.cancel.jobCancels.set("", { store } as never);
    mocks.getJob.mockImplementationOnce(() => {
      throw new Error("fabricated job missing");
    });

    expect(() => handler(handlers, "cancel_job")({} as IpcMainInvokeEvent, null)).toThrow("fabricated job missing");
    expect(mocks.getJob).toHaveBeenCalledWith({ name: "fake database" }, "");
    expect(store).not.toHaveBeenCalled();
    expect(mocks.setJobStatus).not.toHaveBeenCalled();
  });

  it("passes normalized workflow input and the fabricated approval requester to the runner", async () => {
    const queue = {
      cancelState: { jobCancels: new Map() },
      rooms: { current: vi.fn() },
      sink: { emit: vi.fn() },
      starters: new Map(),
      state: { runningJob: null },
    } as unknown as NonNullable<RoomManagerDeps["jobQueue"]>;
    const approval = vi.fn(async () => true);
    mocks.createScriptApprovalRequester.mockReturnValue(approval);
    mocks.runWorkflowCommand.mockResolvedValue("fake-run-2");
    const { deps, emit, handlers, state } = fixture({ jobQueue: queue } as RoomManagerDeps);

    await expect(handler(handlers, "run_workflow")({} as IpcMainInvokeEvent, { id: 19, fileId: "file-8" }))
      .resolves.toBe("fake-run-2");

    expect(mocks.createScriptApprovalRequester).toHaveBeenCalledWith(state, "/userdata", emit);
    expect(mocks.runWorkflowCommand).toHaveBeenCalledWith(
      expect.objectContaining({ rooms: deps.jobQueue?.rooms, scriptRunApproved: approval }),
      "19",
      "file-8",
    );
  });

  it("normalizes an invalid workflow payload before forwarding a fabricated runner failure", async () => {
    const queue = {
      cancelState: { jobCancels: new Map() },
      rooms: { current: vi.fn() },
      sink: { emit: vi.fn() },
      starters: new Map(),
      state: { runningJob: null },
    } as unknown as NonNullable<RoomManagerDeps["jobQueue"]>;
    mocks.runWorkflowCommand.mockRejectedValue(new Error("fabricated workflow failure"));
    const { handlers } = fixture({ jobQueue: queue } as RoomManagerDeps);

    await expect(handler(handlers, "run_workflow")({} as IpcMainInvokeEvent, null))
      .rejects.toThrow("fabricated workflow failure");
    expect(mocks.runWorkflowCommand).toHaveBeenCalledWith(expect.any(Object), "", null);
  });
});
