import { describe, expect, it, vi } from "vitest";

import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import {
  createScriptBytesApprovalRequester,
  registerScriptSurfaceIpcWithOps,
  runScriptFile,
  runScriptFileWithOps,
  type RunScriptFileOps,
  type ScriptSurfaceIpcOps,
} from "./scriptSurfaceIpc.js";

function stateWithRoom(): RoomManagerState {
  return {
    room: { conn: { tag: "fake-db" }, path: "/fake/room", workspace: { tag: "fake-workspace" } },
    rollingBack: false,
    scriptPending: new Map(),
  } as unknown as RoomManagerState;
}

function fakeRunOps(approved: readonly string[], allow = true) {
  const readRoomFile = vi.fn(async () => ({ name: "report.py", bytes: Buffer.from("print('fake')") }));
  const request = vi.fn(async () => allow);
  const requestApproval = vi.fn(() => request);
  const ensureScriptWorkflow = vi.fn(() => "workflow-1");
  const startWorkflowRun = vi.fn(async () => "run-1");
  const scriptLangOf = vi.fn(() => "py");
  const ops = {
    readRoomFile,
    scriptLangOf,
    parseScriptManifest: vi.fn(() => ({
      interpreter: "py", deps: [], inputs: [], outputs: [], timeoutSecs: 30, shortcut: "none",
    })),
    resolveInterpreter: vi.fn(() => ({ program: "/fake/python", argvPrefix: [] })),
    scriptFingerprint: vi.fn(() => "fake-sha"),
    readScriptApprovals: vi.fn(() => approved),
    requestApproval,
    ensureScriptWorkflow,
    startWorkflowRun,
  } as unknown as RunScriptFileOps;
  return {
    ops, readRoomFile, requestApproval, request, ensureScriptWorkflow, startWorkflowRun, scriptLangOf,
  };
}

describe("runScriptFile with fake room, interpreter, approval, and workflow seams", () => {
  it("the production wrapper keeps the no-room refusal before any script boundary", async () => {
    await expect(runScriptFile(
      { room: null } as RoomManagerState,
      {} as RoomManagerDeps,
      "/fake/user",
      vi.fn(),
      "file-0",
    )).rejects.toThrow("No room is open.");
  });

  it("runs an already-approved fake script without opening an approval card", async () => {
    const state = stateWithRoom();
    const fakes = fakeRunOps(["fake-sha"]);
    const emit = vi.fn();

    await expect(
      runScriptFileWithOps(state, { jobQueue: {} } as RoomManagerDeps, "/fake/user", emit, "file-1", fakes.ops),
    ).resolves.toBe("run-1");

    expect(fakes.requestApproval).not.toHaveBeenCalled();
    expect(fakes.ensureScriptWorkflow).toHaveBeenCalledWith(state.room!.conn, "file-1", "report.py");
    expect(fakes.startWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ cacheDir: "/fake/user/cache", userDataDir: "/fake/user", emit }),
      "workflow-1", "manual", null, new Set(["fake-sha"]),
    );
  });

  it("requests fake approval before creating the workflow and rejects a denial", async () => {
    const state = stateWithRoom();
    const allowed = fakeRunOps([]);
    const emit = vi.fn();

    await expect(
      runScriptFileWithOps(state, { jobQueue: {} } as RoomManagerDeps, "/fake/user", emit, "file-2", allowed.ops),
    ).resolves.toBe("run-1");
    expect(allowed.request).toHaveBeenCalledWith(expect.objectContaining({
      fileId: "file-2", name: "report.py", sha: "fake-sha", interpreterLine: expect.any(String),
    }));

    const denied = fakeRunOps([], false);
    await expect(
      runScriptFileWithOps(state, { jobQueue: {} } as RoomManagerDeps, "/fake/user", emit, "file-3", denied.ops),
    ).rejects.toThrow("This script was not approved to run.");
    expect(denied.ensureScriptWorkflow).not.toHaveBeenCalled();
  });

  it("fails before fake file or runtime access when no room is open", async () => {
    const state = { room: null } as unknown as RoomManagerState;
    const fakes = fakeRunOps([]);

    await expect(
      runScriptFileWithOps(state, { jobQueue: {} } as RoomManagerDeps, "/fake/user", vi.fn(), "file", fakes.ops),
    ).rejects.toThrow("No room is open.");
    expect(fakes.readRoomFile).not.toHaveBeenCalled();
  });

  it("rejects a fake non-script before manifest, runner, or workflow calls", async () => {
    const state = stateWithRoom();
    const fakes = fakeRunOps(["fake-sha"]);
    fakes.scriptLangOf.mockReturnValue(null);

    await expect(
      runScriptFileWithOps(state, { jobQueue: {} } as RoomManagerDeps, "/fake/user", vi.fn(), "file", fakes.ops),
    ).rejects.toThrow("Only .py or .js files can be run as scripts.");
    expect(fakes.ops.parseScriptManifest).not.toHaveBeenCalled();
    expect(fakes.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("fails after fake approval when the workflow queue is unavailable", async () => {
    const state = stateWithRoom();
    const fakes = fakeRunOps(["fake-sha"]);

    await expect(
      runScriptFileWithOps(state, {} as RoomManagerDeps, "/fake/user", vi.fn(), "file", fakes.ops),
    ).rejects.toThrow("The job queue is unavailable.");
    expect(fakes.ensureScriptWorkflow).toHaveBeenCalled();
    expect(fakes.startWorkflowRun).not.toHaveBeenCalled();
  });
});

describe("script bytes approval timeout", () => {
  it("removes an unanswered request and refuses it when the approval window expires", async () => {
    vi.useFakeTimers();
    const state = stateWithRoom();
    const emit = vi.fn();
    const request = createScriptBytesApprovalRequester(state, "/fake/user", emit)(
      "report.py",
      Buffer.from("print('fake')"),
    );
    const rejected = expect(request).rejects.toThrow("This skill script was not approved to run.");

    await vi.advanceTimersByTimeAsync(180_000);

    await rejected;
    expect(state.scriptPending.size).toBe(0);
    expect(emit).toHaveBeenCalledWith("script-approve-request", expect.objectContaining({
      name: "report.py",
    }));
    vi.useRealTimers();
  });
});

describe("script IPC handlers with fabricated IPC, room, event, and workflow operations", () => {
  it("routes every callback through its fake operation with normalized arguments", async () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const ipc = { handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler)) };
    const emit = vi.fn();
    const pending = new Map();
    const state = { ...stateWithRoom(), scriptPending: pending };
    const ops = {
      listScriptsInRoom: vi.fn(() => [{ id: "script" }]),
      resolveScriptRun: vi.fn(),
      setScriptScheduleInRoom: vi.fn(async () => {}),
      runScriptFile: vi.fn(async () => "run-9"),
    } as unknown as ScriptSurfaceIpcOps;

    registerScriptSurfaceIpcWithOps(
      ipc, state, { jobQueue: {} } as RoomManagerDeps, "/fake/user", emit, ops,
    );

    expect(handlers.get("list_scripts")!({})).toEqual([{ id: "script" }]);
    handlers.get("resolve_script_run")!({}, { id: 4, decision: "allow" });
    await handlers.get("set_script_schedule")!({}, {
      fileId: 8, kind: "daily", param: 900, enabled: true,
    });
    await expect(handlers.get("run_script")!({}, { fileId: 5 })).resolves.toBe("run-9");

    expect(ops.listScriptsInRoom).toHaveBeenCalledWith(
      expect.objectContaining({ db: state.room!.conn, path: "/fake/room", workspace: state.room!.workspace }),
      "/fake/user",
    );
    expect(ops.resolveScriptRun).toHaveBeenCalledWith(pending, "4", "allow");
    expect(ops.setScriptScheduleInRoom).toHaveBeenCalledWith(
      expect.any(Object), "/fake/user", "8", "daily", "900", true,
    );
    expect(emit).toHaveBeenCalledWith("workflows-changed", undefined);
    expect(ops.runScriptFile).toHaveBeenCalledWith(state, expect.any(Object), "/fake/user", emit, "5");
  });
});
