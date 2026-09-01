import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  randomUUID: vi.fn(),
  listFiles: vi.fn(),
  readRoomFile: vi.fn(),
  addScriptApproval: vi.fn(),
  ensureScriptWorkflow: vi.fn(),
  interpreterLine: vi.fn(),
  listScriptsInRoom: vi.fn(),
  readScriptApprovals: vi.fn(),
  resolveScriptRun: vi.fn(),
  setScriptScheduleInRoom: vi.fn(),
  parseScriptManifest: vi.fn(),
  referencedRoomFiles: vi.fn(),
  resolveInterpreter: vi.fn(),
  scriptFingerprint: vi.fn(),
  scriptLangOf: vi.fn(),
  startWorkflowRun: vi.fn(),
}));

vi.mock("node:crypto", () => ({ randomUUID: bridge.randomUUID }));
vi.mock("./db-host/files.js", () => ({ listFiles: bridge.listFiles }));
vi.mock("./workspace/roomContent.js", () => ({ readRoomFile: bridge.readRoomFile }));
vi.mock("./scriptConsent.js", () => ({
  addScriptApproval: bridge.addScriptApproval,
  ensureScriptWorkflow: bridge.ensureScriptWorkflow,
  interpreterLine: bridge.interpreterLine,
  listScriptsInRoom: bridge.listScriptsInRoom,
  readScriptApprovals: bridge.readScriptApprovals,
  resolveScriptRun: bridge.resolveScriptRun,
  setScriptScheduleInRoom: bridge.setScriptScheduleInRoom,
}));
vi.mock("./scriptRun.js", () => ({
  parseScriptManifest: bridge.parseScriptManifest,
  referencedRoomFiles: bridge.referencedRoomFiles,
  resolveInterpreter: bridge.resolveInterpreter,
  scriptFingerprint: bridge.scriptFingerprint,
  scriptLangOf: bridge.scriptLangOf,
}));
vi.mock("./workflowRuns.js", () => ({ startWorkflowRun: bridge.startWorkflowRun }));

import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import {
  createScriptApprovalRequester,
  createScriptBytesApprovalRequester,
  registerScriptSurfaceIpcWithOps,
  type ScriptSurfaceIpcOps,
} from "./scriptSurfaceIpc.js";

function stateWithRoom(): RoomManagerState {
  return {
    room: { conn: { id: "fake-db" }, path: "/fake/room", workspace: { id: "fake-workspace" } },
    rollingBack: false,
    scriptPending: new Map(),
  } as unknown as RoomManagerState;
}

async function flush(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function requester(state: RoomManagerState, emit = vi.fn()) {
  return {
    emit,
    request: createScriptApprovalRequester(state, "/fake/user", emit),
  };
}

async function pendingDecision(
  state: RoomManagerState,
  request: Promise<boolean>,
  id = "approval-id",
) {
  await flush();
  const answer = state.scriptPending.get(id);
  if (!answer) throw new Error("approval card was not registered");
  return { answer, request };
}

beforeEach(() => {
  vi.useRealTimers();
  bridge.randomUUID.mockReset().mockReturnValue("approval-id");
  bridge.listFiles.mockReset().mockReturnValue([
    { name: "already.txt" },
    { name: "mentioned.md" },
  ]);
  bridge.readRoomFile.mockReset().mockResolvedValue({
    name: "tool.py",
    bytes: Buffer.from("# mentions mentioned.md"),
  });
  bridge.addScriptApproval.mockReset();
  bridge.ensureScriptWorkflow.mockReset();
  bridge.interpreterLine.mockReset().mockReturnValue("python tool.py");
  bridge.listScriptsInRoom.mockReset().mockReturnValue([{ id: "script-1" }]);
  bridge.readScriptApprovals.mockReset().mockReturnValue([]);
  bridge.resolveScriptRun.mockReset();
  bridge.setScriptScheduleInRoom.mockReset().mockResolvedValue(undefined);
  bridge.parseScriptManifest.mockReset().mockReturnValue({
    deps: ["requests"],
    inputs: ["already.txt"],
    outputs: ["result.md"],
    timeoutSecs: 45,
  });
  bridge.referencedRoomFiles.mockReset().mockReturnValue(["ALREADY.TXT", "mentioned.md"]);
  bridge.resolveInterpreter.mockReset();
  bridge.scriptFingerprint.mockReset();
  bridge.scriptLangOf.mockReset();
  bridge.startWorkflowRun.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("createScriptApprovalRequester with fabricated room and card state", () => {
  it("returns immediately for an already approved fingerprint without reading a file", async () => {
    const state = stateWithRoom();
    bridge.readScriptApprovals.mockReturnValue(["known-sha"]);

    await expect(requester(state).request({
      fileId: "file-1", name: "tool.py", sha: "known-sha", interpreterLine: "python tool.py",
    })).resolves.toBe(true);

    expect(bridge.readRoomFile).not.toHaveBeenCalled();
    expect(state.scriptPending).toEqual(new Map());
  });

  it("rejects an approval request with no fabricated room", async () => {
    const state = { room: null, scriptPending: new Map() } as unknown as RoomManagerState;

    await expect(requester(state).request({
      fileId: "file-1", name: "tool.py", sha: "new-sha", interpreterLine: "python tool.py",
    })).rejects.toThrow("No room is open.");
    expect(bridge.readRoomFile).not.toHaveBeenCalled();
  });

  it("emits a deduplicated fake approval card and remembers an approved answer", async () => {
    const state = stateWithRoom();
    const { request, emit } = requester(state);
    const pending = request({
      fileId: "file-9", name: "tool.py", sha: "remember-sha", interpreterLine: "python tool.py",
    });
    const { answer } = await pendingDecision(state, pending);

    expect(emit).toHaveBeenCalledWith("script-approve-request", {
      id: "approval-id",
      name: "tool.py",
      interpreterLine: "python tool.py",
      deps: ["requests"],
      inputs: ["already.txt", "mentioned.md"],
      outputs: ["result.md"],
      timeout: 45,
    });
    answer({ approved: true, remember: true });
    await expect(pending).resolves.toBe(true);
    expect(bridge.addScriptApproval).toHaveBeenCalledWith("/fake/user", "remember-sha");
  });

  it("returns a fabricated denial without remembering it and declines a timed-out request", async () => {
    const state = stateWithRoom();
    const denied = requester(state).request({
      fileId: "file-3", name: "tool.py", sha: "deny-sha", interpreterLine: "python tool.py",
    });
    const { answer } = await pendingDecision(state, denied);
    answer({ approved: false, remember: true });
    await expect(denied).resolves.toBe(false);
    expect(bridge.addScriptApproval).not.toHaveBeenCalled();

    vi.useFakeTimers();
    const timeoutState = stateWithRoom();
    bridge.readRoomFile.mockResolvedValueOnce({ name: "empty.py", bytes: undefined });
    const timedOut = requester(timeoutState).request({
      fileId: "file-4", name: "empty.py", sha: "timeout-sha", interpreterLine: "python empty.py",
    });
    await pendingDecision(timeoutState, timedOut);
    await vi.advanceTimersByTimeAsync(180_000);
    await expect(timedOut).resolves.toBe(false);
    expect(timeoutState.scriptPending).toEqual(new Map());
  });
});

describe("createScriptBytesApprovalRequester with fabricated card state", () => {
  it("returns an already approved script's derived runner and manifest without emitting a card", async () => {
    const state = stateWithRoom();
    const emit = vi.fn();
    const manifest = { deps: ["requests"], inputs: [], outputs: ["result.md"], timeoutSecs: 45 };
    const runner = { program: "/fake/python", argvPrefix: ["-u"] };
    bridge.parseScriptManifest.mockReturnValue(manifest);
    bridge.resolveInterpreter.mockReturnValue(runner);
    bridge.scriptFingerprint.mockReturnValue("known-sha");
    bridge.readScriptApprovals.mockReturnValue(["known-sha"]);

    await expect(
      createScriptBytesApprovalRequester(state, "/fake/user", emit)("skill.py", Buffer.from("print('fake')")),
    ).resolves.toEqual({ runner, manifest });

    expect(emit).not.toHaveBeenCalled();
    expect(state.scriptPending).toEqual(new Map());
  });

  it("emits the script metadata, remembers an approval, and keeps denial visible", async () => {
    const state = stateWithRoom();
    const emit = vi.fn();
    const manifest = { deps: ["requests"], inputs: ["input.md"], outputs: ["result.md"], timeoutSecs: 45 };
    const runner = { program: "/fake/python", argvPrefix: ["-u"] };
    bridge.parseScriptManifest.mockReturnValue(manifest);
    bridge.resolveInterpreter.mockReturnValue(runner);
    bridge.scriptFingerprint.mockReturnValue("new-sha");

    const approval = createScriptBytesApprovalRequester(state, "/fake/user", emit);
    const allowed = approval("skill.py", Buffer.from("print('fake')"));
    await flush();
    const accept = state.scriptPending.get("approval-id");
    if (!accept) throw new Error("approval card was not registered");
    expect(emit).toHaveBeenCalledWith("script-approve-request", {
      id: "approval-id",
      name: "skill.py",
      interpreterLine: "python tool.py",
      deps: manifest.deps,
      inputs: manifest.inputs,
      outputs: manifest.outputs,
      timeout: manifest.timeoutSecs,
    });
    accept({ approved: true, remember: true });
    await expect(allowed).resolves.toEqual({ runner, manifest });
    expect(bridge.addScriptApproval).toHaveBeenCalledWith("/fake/user", "new-sha");

    const denied = approval("skill.py", Buffer.from("print('fake')"));
    await flush();
    const reject = state.scriptPending.get("approval-id");
    if (!reject) throw new Error("approval card was not registered");
    reject({ approved: false, remember: false });
    await expect(denied).rejects.toThrow("This skill script was not approved to run.");
  });
});

describe("script surface IPC registration with fabricated handlers", () => {
  it("registers every handler and normalizes missing or non-object arguments", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) };
    const state = stateWithRoom();
    const emit = vi.fn();
    const ops = {
      listScriptsInRoom: bridge.listScriptsInRoom,
      resolveScriptRun: bridge.resolveScriptRun,
      setScriptScheduleInRoom: bridge.setScriptScheduleInRoom,
      runScriptFile: vi.fn().mockResolvedValue("fake-run"),
    } as unknown as ScriptSurfaceIpcOps;

    registerScriptSurfaceIpcWithOps(
      ipc, state, { jobQueue: {} } as RoomManagerDeps, "/fake/user", emit, ops,
    );
    expect([...handlers.keys()]).toEqual([
      "list_scripts", "resolve_script_run", "set_script_schedule", "run_script",
    ]);
    expect(handlers.get("list_scripts")!({})).toEqual([{ id: "script-1" }]);
    handlers.get("resolve_script_run")!({}, null);
    await handlers.get("set_script_schedule")!({}, "not-an-object");
    await expect(handlers.get("run_script")!({}, undefined)).resolves.toBe("fake-run");

    expect(bridge.resolveScriptRun).toHaveBeenCalledWith(state.scriptPending, "", "deny");
    expect(bridge.setScriptScheduleInRoom).toHaveBeenCalledWith(
      expect.any(Object), "/fake/user", "", "", "", false,
    );
    expect(emit).toHaveBeenCalledWith("workflows-changed", undefined);
    expect(ops.runScriptFile).toHaveBeenCalledWith(state, expect.any(Object), "/fake/user", emit, "");
  });

  it("keeps room-bound handlers unavailable when the fake room is closed", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) };
    const state = { room: null, scriptPending: new Map() } as unknown as RoomManagerState;
    const ops = {
      listScriptsInRoom: bridge.listScriptsInRoom,
      resolveScriptRun: bridge.resolveScriptRun,
      setScriptScheduleInRoom: bridge.setScriptScheduleInRoom,
      runScriptFile: bridge.startWorkflowRun,
    } as unknown as ScriptSurfaceIpcOps;

    registerScriptSurfaceIpcWithOps(
      ipc, state, { jobQueue: {} } as RoomManagerDeps, "/fake/user", vi.fn(), ops,
    );
    expect(() => handlers.get("list_scripts")!({})).toThrow("No room is open.");
    await expect(handlers.get("set_script_schedule")!({}, {})).rejects.toThrow("No room is open.");
    expect(bridge.listScriptsInRoom).not.toHaveBeenCalled();
    expect(bridge.setScriptScheduleInRoom).not.toHaveBeenCalled();
  });
});
