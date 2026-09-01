import { beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

const mocks = vi.hoisted(() => ({
  createRecBridgeCtx: vi.fn(),
  listModels: vi.fn(),
  modelSetting: vi.fn(),
  recCtx: { state: { liveFileId: null as string | null } },
  recStop: vi.fn(),
  runsOnThisMac: vi.fn(),
  startRecRead: vi.fn(),
}));

vi.mock("../engineRouting.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../engineRouting.js")>()),
  listModels: mocks.listModels,
}));
vi.mock("../gatherContext.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gatherContext.js")>()),
  modelSetting: mocks.modelSetting,
}));
vi.mock("../capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../capabilities.js")>()),
  runsOnThisMac: mocks.runsOnThisMac,
}));
vi.mock("../recRead.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../recRead.js")>()),
  startRecRead: mocks.startRecRead,
}));
vi.mock("../recBridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../recBridge.js")>()),
  createRecBridgeCtx: mocks.createRecBridgeCtx,
  recStop: mocks.recStop,
}));

import type { DialogDeps } from "../dialogTools.js";
import type { RoomManagerDeps } from "../roomManager.js";
import type { ShellDeps } from "../shellTools.js";
import {
  createDefaultRoomManagerDeps,
  createRoomManagerState,
  registerAllIpc,
  type HostBridge,
} from "./registry.js";

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type PassEngine = { chatModel: string; lane: "local_llm" | "cloud" };
type ReadOptions = { resolvePassEngine(): Promise<PassEngine> };

const fakeEvent = {} as IpcMainInvokeEvent;

function buildReadStart(): {
  deps: RoomManagerDeps;
  state: ReturnType<typeof createRoomManagerState>;
  readStart: Listener;
} {
  const handlers = new Map<string, Listener>();
  const state = createRoomManagerState();
  const emit = vi.fn();
  const deps = createDefaultRoomManagerDeps("/fabricated/registry-user-data", emit);
  const jobQueue = {} as NonNullable<RoomManagerDeps["jobQueue"]>;
  deps.jobQueue = jobQueue;

  const host: HostBridge = {
    setUnsavedEdits: () => undefined,
    rearmQuitGuard: () => undefined,
    confirmQuit: () => undefined,
    syncMenu: () => undefined,
    appVersion: () => "test",
    osVersion: () => "test",
    checkForUpdate: async () => null,
    installUpdate: async () => undefined,
    windowContentView: () => null,
    focusMainWindow: () => undefined,
    openPath: async () => undefined,
  };
  const dialog: DialogDeps = {
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
      showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    } as DialogDeps["dialog"],
    getMainWindow: () => null,
  };
  const shell: ShellDeps = {
    shell: {
      openExternal: async () => undefined,
      openPath: async () => "",
      showItemInFolder: () => undefined,
      trashItem: async () => undefined,
    } as ShellDeps["shell"],
    openWithApp: async () => undefined,
  };

  registerAllIpc({
    ipcMain: {
      handle(channel: string, listener: Listener): void {
        handlers.set(channel, listener);
      },
    } as Pick<IpcMain, "handle">,
    state,
    deps,
    emit,
    host,
    dialog,
    shell,
    userDataDir: "/fabricated/registry-user-data",
    resourcesPath: null,
  });

  const readStart = handlers.get("rec_read_start");
  if (readStart === undefined) throw new Error("rec_read_start was not registered.");
  return { deps, state, readStart };
}

function openFabricatedRoom(state: ReturnType<typeof createRoomManagerState>): void {
  state.room = {
    conn: {} as Database.Database,
    path: "/fabricated/room",
    name: "Fabricated room",
    password: "test password",
  };
}

async function startReadAndCaptureResolver(readStart: Listener): Promise<{
  result: unknown;
  resolvePassEngine: ReadOptions["resolvePassEngine"];
}> {
  const result = await readStart(fakeEvent, { id: "recording-1" });
  const options = mocks.startRecRead.mock.calls[0]?.[1] as ReadOptions | undefined;
  if (options === undefined) throw new Error("The recording read job was not started.");
  return { result, resolvePassEngine: options.resolvePassEngine };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recCtx.state.liveFileId = null;
  mocks.createRecBridgeCtx.mockReturnValue(mocks.recCtx);
  mocks.listModels.mockResolvedValue(["qwen3.5:4b-mlx"]);
  mocks.modelSetting.mockReturnValue("configured-model");
  mocks.recStop.mockResolvedValue({});
  mocks.runsOnThisMac.mockReturnValue(true);
  mocks.startRecRead.mockResolvedValue("rec-read-job");
});

function stopRecordingAndWait(deps: RoomManagerDeps): (timeoutMs: number) => Promise<void> {
  if (deps.stopRecordingAndWait === undefined) throw new Error("recording stop callback was not registered");
  return deps.stopRecordingAndWait;
}

describe("registerAllIpc recording-read engine resolution", () => {
  it("uses the room's configured model and the local lane", async () => {
    const { state, readStart } = buildReadStart();
    openFabricatedRoom(state);

    const { result, resolvePassEngine } = await startReadAndCaptureResolver(readStart);

    expect(result).toBe("rec-read-job");
    expect(mocks.startRecRead).toHaveBeenCalledWith(
      expect.objectContaining({ starters: expect.any(Map) }),
      expect.objectContaining({ resolvePassEngine: expect.any(Function) }),
      "recording-1",
    );

    expect(await resolvePassEngine()).toEqual({ chatModel: "configured-model", lane: "local_llm" });
    expect(mocks.listModels).toHaveBeenCalledOnce();
    expect(mocks.modelSetting).toHaveBeenCalledWith(state.room?.conn);
    expect(mocks.runsOnThisMac).toHaveBeenCalledWith("configured-model");
  });

  it("uses the local fallback model and cloud lane when the room has no setting", async () => {
    const { state, readStart } = buildReadStart();
    openFabricatedRoom(state);
    mocks.modelSetting.mockReturnValue(null);
    mocks.runsOnThisMac.mockReturnValue(false);

    const { resolvePassEngine } = await startReadAndCaptureResolver(readStart);

    expect(await resolvePassEngine()).toEqual({ chatModel: "qwen3.5:4b-mlx", lane: "cloud" });
    expect(mocks.listModels).toHaveBeenCalledOnce();
    expect(mocks.runsOnThisMac).toHaveBeenCalledWith("qwen3.5:4b-mlx");
  });

  it("refuses a closed room before querying fabricated model data", async () => {
    const { state, readStart } = buildReadStart();
    openFabricatedRoom(state);
    const { resolvePassEngine } = await startReadAndCaptureResolver(readStart);
    state.room = null;

    await expect(resolvePassEngine()).rejects.toThrow("No room is open.");
    expect(mocks.listModels).not.toHaveBeenCalled();
  });

  it("propagates a fabricated model-catalog failure without choosing an engine", async () => {
    const { state, readStart } = buildReadStart();
    openFabricatedRoom(state);
    mocks.listModels.mockRejectedValue(new Error("catalog unavailable"));
    const { resolvePassEngine } = await startReadAndCaptureResolver(readStart);

    await expect(resolvePassEngine()).rejects.toThrow("catalog unavailable");
    expect(mocks.modelSetting).not.toHaveBeenCalled();
    expect(mocks.runsOnThisMac).not.toHaveBeenCalled();
  });
});

describe("registerAllIpc live recording stop callback", () => {
  it("does not dispatch a stop when the fabricated recording context has no live file", async () => {
    const { deps } = buildReadStart();

    await expect(stopRecordingAndWait(deps)(10)).resolves.toBeUndefined();

    expect(mocks.recStop).not.toHaveBeenCalled();
  });

  it("dispatches the registered fabricated recording context and settles successfully", async () => {
    mocks.recCtx.state.liveFileId = "live-recording";
    const { deps } = buildReadStart();

    await expect(stopRecordingAndWait(deps)(10)).resolves.toBeUndefined();

    expect(mocks.recStop).toHaveBeenCalledWith(mocks.recCtx);
  });

  it("preserves a fabricated recording-stop failure", async () => {
    mocks.recCtx.state.liveFileId = "live-recording";
    mocks.recStop.mockRejectedValue(new Error("fabricated recording write failed"));
    const { deps } = buildReadStart();

    await expect(stopRecordingAndWait(deps)(10)).rejects.toThrow("fabricated recording write failed");
  });

  it("turns a fabricated delayed recording stop into the registered timeout error", async () => {
    vi.useFakeTimers();
    try {
      mocks.recCtx.state.liveFileId = "live-recording";
      mocks.recStop.mockReturnValue(new Promise<void>(() => {}));
      const { deps } = buildReadStart();
      const stopping = stopRecordingAndWait(deps)(10);
      const timeout = expect(stopping).rejects.toThrow("Timed out while saving the live recording.");

      await vi.advanceTimersByTimeAsync(10);

      await timeout;
    } finally {
      vi.useRealTimers();
    }
  });
});
