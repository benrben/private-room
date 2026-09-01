import { beforeEach, describe, expect, it, vi } from "vitest";
import { CancelFlag } from "./cancel.js";
import type { LiveAppServices } from "./liveAppServices.js";
import type { RoomManagerState } from "./roomManager.js";

const mocks = vi.hoisted(() => ({
  runsOnThisMac: vi.fn(),
  createToolEffects: vi.fn(),
  advisorsEnabled: vi.fn(),
  modelSetting: vi.fn(),
  webAccessEnabled: vi.fn(),
  createRoomBridge: vi.fn(),
  webLanesFromSettings: vi.fn(),
  activePolicy: vi.fn(),
  roomServerDispatcherFactory: vi.fn(),
  listModels: vi.fn(),
  bestDefault: vi.fn(),
  streamAnswer: vi.fn(),
}));

vi.mock("./capabilities.js", () => ({ runsOnThisMac: mocks.runsOnThisMac }));
vi.mock("./externalDetection.js", () => ({ detectedExternal: new Set() }));
vi.mock("./execTool.js", () => ({ createToolEffects: mocks.createToolEffects }));
vi.mock("./gatherContext.js", () => ({
  advisorsEnabled: mocks.advisorsEnabled,
  modelSetting: mocks.modelSetting,
  webAccessEnabled: mocks.webAccessEnabled,
}));
vi.mock("./moonshotServer.js", () => ({
  createRoomBridge: mocks.createRoomBridge,
  webLanesFromSettings: mocks.webLanesFromSettings,
}));
vi.mock("./privacy.js", () => ({ activePolicy: mocks.activePolicy }));
vi.mock("./roomServerLive.js", () => ({
  roomServerDispatcherFactory: mocks.roomServerDispatcherFactory,
}));
vi.mock("./engineRouting.js", () => ({ listModels: mocks.listModels }));
vi.mock("./turnContext.js", () => ({ bestDefault: mocks.bestDefault }));
vi.mock("./turnEngine.js", () => ({ streamAnswer: mocks.streamAnswer }));

import { createWorkflowAgentRun } from "./workflowAgentRun.js";

const room = { path: "/rooms/one.roomai", conn: {} };
const state = () => ({ room }) as unknown as RoomManagerState;
const services = {} as LiveAppServices;

describe("createWorkflowAgentRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runsOnThisMac.mockReturnValue(true);
    mocks.createToolEffects.mockReturnValue({ kind: "fake-effects" });
    mocks.advisorsEnabled.mockReturnValue(true);
    mocks.modelSetting.mockReturnValue("local-test-model");
    mocks.webAccessEnabled.mockReturnValue(true);
    mocks.webLanesFromSettings.mockReturnValue(["fake-web-lane"]);
    mocks.activePolicy.mockReturnValue(null);
    mocks.listModels.mockResolvedValue(["fallback-model"]);
    mocks.bestDefault.mockReturnValue("fallback-model");
    mocks.roomServerDispatcherFactory.mockReturnValue(() => "fake-dispatcher");
    mocks.streamAnswer.mockResolvedValue("workflow answer");
  });

  it("passes the pinned room, job cancellation, and local status into a fake turn then closes its bridge", async () => {
    const stopAndWait = vi.fn().mockResolvedValue(undefined);
    mocks.createRoomBridge.mockResolvedValue({ port: 4312, token: "fake-token", stopAndWait });
    const send = vi.fn();
    const run = createWorkflowAgentRun(state(), send, services);
    const cancel = new CancelFlag();

    await expect(run("summarize the room", cancel, room.path)).resolves.toBe("workflow answer");

    expect(mocks.createRoomBridge).toHaveBeenCalledWith({
      scope: { kind: "LocalEngine" },
      dispatcher: "fake-dispatcher",
    });
    expect(mocks.streamAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "local-test-model",
        question: "summarize the room",
        cancel,
        webEnabled: true,
        advisorsOn: true,
        mcp: { url: "http://127.0.0.1:4312/mcp", token: "fake-token" },
      }),
      expect.objectContaining({ send: expect.any(Function) }),
    );
    expect(stopAndWait).toHaveBeenCalledOnce();
  });

  it("keeps job errors, missing inputs, stale-room refusal, and cloud fallback distinct", async () => {
    const run = createWorkflowAgentRun(state(), vi.fn(), services);
    await expect(run("ask", undefined, room.path)).rejects.toThrow("job cancellation flag");
    await expect(run("ask", new CancelFlag(), undefined)).rejects.toThrow("pinned room");
    await expect(run("ask", new CancelFlag(), "/rooms/other.roomai")).rejects.toThrow("no longer open");

    const stopAndWait = vi.fn().mockResolvedValue(undefined);
    mocks.listModels.mockRejectedValueOnce(new Error("fake model list unavailable"));
    mocks.modelSetting.mockReturnValueOnce(null);
    mocks.bestDefault.mockReturnValueOnce("cloud-fallback-model");
    mocks.runsOnThisMac.mockReturnValueOnce(false);
    mocks.createRoomBridge.mockResolvedValueOnce({ port: 9876, token: "cloud-token", stopAndWait });
    mocks.streamAnswer.mockRejectedValueOnce(new Error("fake workflow failure"));

    await expect(run("ask", new CancelFlag(), room.path)).rejects.toThrow("fake workflow failure");
    expect(mocks.createRoomBridge).toHaveBeenLastCalledWith({
      scope: { kind: "CloudEngine" },
      dispatcher: "fake-dispatcher",
    });
    expect(stopAndWait).toHaveBeenCalledOnce();
  });
});
