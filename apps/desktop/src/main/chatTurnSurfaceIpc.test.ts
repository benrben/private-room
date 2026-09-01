import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";

const mocks = vi.hoisted(() => ({
  activePolicy: vi.fn(),
  ask: vi.fn(),
  chatModelSeesImages: vi.fn(),
  createRoomBridge: vi.fn(),
  createToolEffects: vi.fn(),
  detectedExternal: vi.fn(),
  embedQuestion: vi.fn(),
  groundPreparedImage: vi.fn(),
  groundingPick: vi.fn(),
  handoffChat: vi.fn(),
  listModels: vi.fn(),
  liveTurnRoomSource: vi.fn(),
  modelSetting: vi.fn(),
  prepareImage: vi.fn(),
  roomServerDispatcherFactory: vi.fn(),
  runsOnThisMac: vi.fn(),
  turnEvidencePolicyForQuestion: vi.fn(),
  webAccessEnabled: vi.fn(),
}));

vi.mock("./turnEngine.js", () => ({ ask: mocks.ask, handoffChat: mocks.handoffChat }));
vi.mock("./liveContext.js", () => ({ liveTurnRoomSource: mocks.liveTurnRoomSource }));
vi.mock("./moonshotServer.js", () => ({ createRoomBridge: mocks.createRoomBridge }));
vi.mock("./roomServerLive.js", () => ({ roomServerDispatcherFactory: mocks.roomServerDispatcherFactory }));
vi.mock("./gatherContext.js", () => ({
  modelSetting: mocks.modelSetting,
  turnEvidencePolicyForQuestion: mocks.turnEvidencePolicyForQuestion,
}));
vi.mock("./capabilities.js", () => ({ runsOnThisMac: mocks.runsOnThisMac }));
vi.mock("./externalDetection.js", () => ({ detectedExternal: mocks.detectedExternal }));
vi.mock("./ollamaModels.js", () => ({
  chatModelSeesImages: mocks.chatModelSeesImages,
  groundingPick: mocks.groundingPick,
}));
vi.mock("./privacy.js", () => ({ activePolicy: mocks.activePolicy }));
vi.mock("./retrievalBackfill.js", () => ({ embedQuestion: mocks.embedQuestion }));
vi.mock("./engineRouting.js", () => ({ listModels: mocks.listModels }));
vi.mock("./visionTools.js", () => ({
  groundPreparedImage: mocks.groundPreparedImage,
  prepareImage: mocks.prepareImage,
}));
vi.mock("./execTool.js", () => ({ createToolEffects: mocks.createToolEffects }));
vi.mock("./browser/webAccess.js", () => ({ webAccessEnabled: mocks.webAccessEnabled }));

import { registerChatTurnSurfaceIpc } from "./chatTurnSurfaceIpc.js";

type AskHandler = (event: IpcMainInvokeEvent, raw: unknown) => Promise<unknown>;

function fakeBridge() {
  return {
    port: 4555,
    token: "bridge-token",
    stopAndWait: vi.fn().mockResolvedValue(undefined),
  };
}

function fixture(open = true) {
  const handlers = new Map<string, AskHandler>();
  const room = { conn: { database: "fake" }, path: "/rooms/fake", name: "Fake" };
  const state = {
    room: open ? room : null,
    cancel: { cancels: new Map() },
  } as unknown as RoomManagerState;
  const roomSource = { name: "live room source" };
  const emit = vi.fn();
  const mcpRuntime = {
    manager: {
      servers: [
        { name: "connected", status: "connected" },
        { name: "offline", status: "failed" },
      ],
    },
  };
  mocks.liveTurnRoomSource.mockReturnValue(roomSource);
  registerChatTurnSurfaceIpc(
    { handle: (channel, handler) => handlers.set(channel, handler as AskHandler) } as Pick<IpcMain, "handle">,
    state,
    emit as EventSender,
    mcpRuntime as never,
  );
  const ask = handlers.get("ask");
  if (ask === undefined) throw new Error("ask handler was not registered");
  return { ask, emit, mcpRuntime, room, roomSource, state };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ask.mockResolvedValue({ id: "answer" });
  mocks.createRoomBridge.mockResolvedValue(fakeBridge());
  mocks.createToolEffects.mockReturnValue({ pendingImages: [] });
  mocks.modelSetting.mockReturnValue("cloud-chat");
  mocks.roomServerDispatcherFactory.mockReturnValue(vi.fn(() => ({ name: "room dispatcher" })));
  mocks.runsOnThisMac.mockReturnValue(false);
  mocks.turnEvidencePolicyForQuestion.mockReturnValue("sources");
  mocks.webAccessEnabled.mockReturnValue(true);
});

describe("registerChatTurnSurfaceIpc", () => {
  it("normalizes the renderer request and carries cancellation, room, and connected-server routing into ask", async () => {
    const { ask, emit, room, roomSource, state } = fixture();
    mocks.runsOnThisMac.mockReturnValue(true);

    await expect(ask({} as IpcMainInvokeEvent, {
      askId: 14,
      attachments: ["note.txt", 9, null],
      chatId: 3,
      privacyBypass: "true",
      question: undefined,
      viewing: 5,
    })).resolves.toEqual({ id: "answer" });

    expect(mocks.ask).toHaveBeenCalledWith({
      askId: "14",
      attachments: ["note.txt"],
      chatId: "3",
      privacyBypass: false,
      question: "",
      viewing: null,
    }, expect.objectContaining({
      cancelState: state.cancel,
      effects: { pendingImages: [] },
      room: roomSource,
      send: emit,
    }));
    const deps = mocks.ask.mock.calls[0]?.[1];
    expect(deps.connectedMcpServers()).toEqual(["connected"]);
    expect(deps.mcp()).toEqual({ url: "http://127.0.0.1:4555/mcp", token: "bridge-token" });
    mocks.activePolicy.mockReturnValue(null);
    expect(deps.privacyActive()).toBe(false);
    deps.notifyFilesChanged();
    expect(emit).toHaveBeenCalledWith("room-files-changed", {});
    mocks.listModels.mockResolvedValue(["vision-model"]);
    mocks.groundingPick.mockResolvedValue(null);
    await expect(deps.groundingPass({
      model: "chat-model",
      question: "where",
      image: { fileId: "image-1", name: "diagram.png", bytes: Buffer.from("image") },
    })).resolves.toBeNull();
    mocks.groundingPick.mockResolvedValue("vision-model");
    mocks.prepareImage.mockResolvedValue({ bytes: Buffer.from("prepared"), width: 12, height: 8 });
    mocks.groundPreparedImage.mockResolvedValue([{ x: 1, y: 2 }]);
    await expect(deps.groundingPass({
      model: "chat-model",
      question: "where",
      image: { fileId: "image-1", name: "diagram.png", bytes: Buffer.from("image") },
    })).resolves.toEqual({ fileId: "image-1", name: "diagram.png", boxes: [{ x: 1, y: 2 }] });
    expect(mocks.roomServerDispatcherFactory).toHaveBeenCalledWith(state, emit, undefined);
    expect(mocks.createRoomBridge).toHaveBeenCalledWith(expect.objectContaining({
      scope: { kind: "LocalEngine" },
    }));
    expect(mocks.turnEvidencePolicyForQuestion).toHaveBeenCalledWith(room.conn, "");
  });

  it("uses an empty dispatcher for the hard no-tools policy without constructing the live room dispatcher", async () => {
    const { ask, room } = fixture();
    mocks.turnEvidencePolicyForQuestion.mockReturnValue("no-tools-no-sources");

    await ask({} as IpcMainInvokeEvent, { question: "private", privacyBypass: true });

    expect(mocks.roomServerDispatcherFactory).not.toHaveBeenCalled();
    const bridgeOptions = mocks.createRoomBridge.mock.calls[0]?.[0];
    expect(bridgeOptions.dispatcher.listTools({ kind: "CloudEngine" })).toEqual([]);
    await expect(bridgeOptions.dispatcher.callTool({ kind: "CloudEngine" }, "guessed", {})).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "Tools are disabled for this turn." }],
    });
    expect(mocks.turnEvidencePolicyForQuestion).toHaveBeenCalledWith(room.conn, "private");
    expect(mocks.webAccessEnabled).toHaveBeenCalledWith(room.conn);
  });

  it("refuses an ask before creating a bridge when no room is open", async () => {
    const { ask } = fixture(false);

    await expect(ask({} as IpcMainInvokeEvent, {})).rejects.toThrow("No room is open.");

    expect(mocks.createRoomBridge).not.toHaveBeenCalled();
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it("waits for bridge shutdown when ask rejects", async () => {
    const { ask } = fixture();
    const bridge = fakeBridge();
    mocks.createRoomBridge.mockResolvedValue(bridge);
    mocks.ask.mockRejectedValue(new Error("turn failed"));

    await expect(ask({} as IpcMainInvokeEvent, { askId: "cancel-me" })).rejects.toThrow("turn failed");

    expect(bridge.stopAndWait).toHaveBeenCalledOnce();
  });
});
