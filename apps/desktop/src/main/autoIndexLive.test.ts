import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  autoDeps: null as any,
  createAutoIndexState: vi.fn(() => ({ generation: 0 })),
  filesMissingSummary: vi.fn(),
  getFileExtractedText: vi.fn(),
  listModels: vi.fn(),
  modelSetting: vi.fn(),
  recReadOptions: null as any,
  recReadRowStarter: vi.fn((options: any) => {
    mocks.recReadOptions = options;
    return "rec-read-starter";
  }),
  runsOnThisMac: vi.fn(),
  scheduleAutoIndex: vi.fn((deps: any) => {
    mocks.autoDeps = deps;
  }),
  setFileAiSummary: vi.fn(),
  startDeepSummaryJob: vi.fn(),
  startRecRead: vi.fn(),
  summarizeOneFile: vi.fn(),
  bestLocalDefault: vi.fn(),
}));

vi.mock("./autoIndex.js", () => ({
  createAutoIndexState: mocks.createAutoIndexState,
  scheduleAutoIndex: mocks.scheduleAutoIndex,
}));
vi.mock("./capabilities.js", () => ({ runsOnThisMac: mocks.runsOnThisMac }));
vi.mock("./creativeJobSurfaceIpc.js", () => ({ startDeepSummaryJob: mocks.startDeepSummaryJob }));
vi.mock("./db-host/files.js", () => ({
  filesMissingSummary: mocks.filesMissingSummary,
  getFileExtractedText: mocks.getFileExtractedText,
  setFileAiSummary: mocks.setFileAiSummary,
}));
vi.mock("./engineRouting.js", () => ({ listModels: mocks.listModels }));
vi.mock("./gatherContext.js", () => ({ modelSetting: mocks.modelSetting }));
vi.mock("./ollamaModels.js", () => ({ bestLocalDefault: mocks.bestLocalDefault }));
vi.mock("./recRead.js", () => ({
  recReadRowStarter: mocks.recReadRowStarter,
  startRecRead: mocks.startRecRead,
}));
vi.mock("./summarizeTools.js", () => ({ summarizeOneFile: mocks.summarizeOneFile }));

import { createLiveAutoIndex } from "./autoIndexLive.js";

const ROOM_PATH = "/rooms/active";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function wire() {
  const state = {
    cancel: { cancels: new Map() },
    room: { conn: { name: "db" }, path: ROOM_PATH },
    roomEpoch: 1,
  } as any;
  const deps = {
    jobQueue: { rooms: { current: vi.fn() }, starters: new Map([["other", "starter"]]) },
  } as any;
  const emit = vi.fn();
  const schedule = createLiveAutoIndex(state, deps, emit);
  schedule(ROOM_PATH);
  return { autoDeps: mocks.autoDeps as any, deps, emit, state };
}

async function settles(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion);
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.autoDeps = null;
  mocks.recReadOptions = null;
  mocks.bestLocalDefault.mockReturnValue("fallback-model");
  mocks.filesMissingSummary.mockReturnValue([]);
  mocks.getFileExtractedText.mockReturnValue(null);
  mocks.listModels.mockResolvedValue(["installed-model"]);
  mocks.modelSetting.mockReturnValue("configured-model");
  mocks.runsOnThisMac.mockReturnValue(true);
  mocks.startDeepSummaryJob.mockResolvedValue("deep-job");
  mocks.startRecRead.mockResolvedValue("read-job");
  mocks.summarizeOneFile.mockResolvedValue("summary");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createLiveAutoIndex", () => {
  it("wires the rec-read and scheduler actions to the current room", async () => {
    const { autoDeps, deps, emit, state } = wire();

    expect(mocks.scheduleAutoIndex).toHaveBeenCalledWith(autoDeps, { generation: 0 }, ROOM_PATH);
    expect(deps.jobQueue.starters).toEqual(new Map([["other", "starter"], ["rec_read", "rec-read-starter"]]));

    expect(await mocks.recReadOptions.resolvePassEngine()).toEqual({ chatModel: "configured-model", lane: "local_llm" });
    mocks.runsOnThisMac.mockReturnValue(false);
    mocks.modelSetting.mockReturnValue(null);
    expect(await mocks.recReadOptions.resolvePassEngine()).toEqual({ chatModel: "fallback-model", lane: "cloud" });
    mocks.recReadOptions.onReadDone({ fileId: "recording" });
    expect(emit).toHaveBeenLastCalledWith("rec-read-done", { fileId: "recording" });

    expect(await autoDeps.startDeepSummaryAuto(ROOM_PATH)).toBe("deep-job");
    expect(mocks.startDeepSummaryJob).toHaveBeenCalledWith(state, deps, true);
    expect(await autoDeps.startRecRead(ROOM_PATH, "recording")).toBe("read-job");
    expect(mocks.startRecRead).toHaveBeenCalledWith(deps.jobQueue, expect.objectContaining({ onReadDone: expect.any(Function) }), "recording");

    const recReadExtra = mocks.startRecRead.mock.calls[0][1];
    await recReadExtra.resolvePassEngine();
    recReadExtra.onReadDone({ fileId: "recording" });
    expect(emit).toHaveBeenLastCalledWith("rec-read-done", { fileId: "recording" });

    state.room = null;
    await expect(mocks.recReadOptions.resolvePassEngine()).rejects.toThrow("No room is open.");
    await expect(autoDeps.startDeepSummaryAuto(ROOM_PATH)).rejects.toThrow("room changed");
    await expect(autoDeps.startRecRead(ROOM_PATH, "recording")).rejects.toThrow("room changed");
  });

  it("rejects installation when the background job queue is unavailable", () => {
    const state = { cancel: { cancels: new Map() }, room: null, roomEpoch: 0 } as any;
    expect(() => createLiveAutoIndex(state, {}, vi.fn())).toThrow("background job queue is unavailable");
  });

  it("summarizes in order, announces after commits, and releases the single-flight lock", async () => {
    const { autoDeps, emit } = wire();
    const events: string[] = [];
    const first = deferred<string>();
    mocks.filesMissingSummary.mockReturnValue([["file-1", "One.txt", "text/plain", "sample"]]);
    mocks.getFileExtractedText.mockReturnValue("full text");
    mocks.summarizeOneFile.mockReturnValueOnce(first.promise).mockResolvedValue("next summary");
    mocks.setFileAiSummary.mockImplementation(() => events.push("write"));
    emit.mockImplementation((event: string) => events.push(event));

    autoDeps.spawnSummaryFiller(ROOM_PATH, 0);
    autoDeps.spawnSummaryFiller(ROOM_PATH, 0);
    await settles(() => expect(mocks.summarizeOneFile).toHaveBeenCalledOnce());
    expect(mocks.summarizeOneFile).toHaveBeenCalledWith("configured-model", "One.txt", "text/plain", "full text", "2m");

    first.resolve("first summary");
    await settles(() => expect(emit).toHaveBeenCalledOnce());
    expect(events).toEqual(["write", "room-files-changed"]);

    autoDeps.spawnSummaryFiller(ROOM_PATH, 0);
    await settles(() => expect(emit).toHaveBeenCalledTimes(2));
    expect(mocks.filesMissingSummary).toHaveBeenCalledTimes(2);
  });

  it("honors the requested delay and abandons an ineligible room before reading files", async () => {
    vi.useFakeTimers();
    const { autoDeps } = wire();
    mocks.listModels.mockResolvedValue([]);

    autoDeps.spawnSummaryFiller(ROOM_PATH, 2);
    await Promise.resolve();
    expect(mocks.listModels).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocks.listModels).toHaveBeenCalledOnce();
    expect(mocks.filesMissingSummary).not.toHaveBeenCalled();
  });

  it("stops on cancellation, stale rooms, and rejected summaries without announcing a change", async () => {
    const { autoDeps, emit, state } = wire();
    mocks.filesMissingSummary.mockReturnValue([["file-1", "One.txt", "text/plain", "sample"]]);
    state.cancel.cancels.set("turn", {});
    autoDeps.spawnSummaryFiller(ROOM_PATH, 0);
    await settles(() => expect(mocks.filesMissingSummary).toHaveBeenCalledOnce());
    expect(mocks.summarizeOneFile).not.toHaveBeenCalled();

    state.cancel.cancels.clear();
    const late = deferred<string>();
    mocks.summarizeOneFile.mockReturnValueOnce(late.promise).mockRejectedValueOnce(new Error("model refused"));
    autoDeps.spawnSummaryFiller(ROOM_PATH, 0);
    await settles(() => expect(mocks.summarizeOneFile).toHaveBeenCalledOnce());
    state.room = { conn: { name: "new" }, path: "/rooms/new" };
    late.resolve("summary");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.setFileAiSummary).not.toHaveBeenCalled();

    state.room = { conn: { name: "db" }, path: ROOM_PATH };
    autoDeps.spawnSummaryFiller(ROOM_PATH, 0);
    await settles(() => expect(mocks.summarizeOneFile).toHaveBeenCalledTimes(2));
    expect(mocks.setFileAiSummary).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalledWith("room-files-changed", {});
  });

  it("reports background failures and accepts another pass after finally releases it", async () => {
    const { autoDeps, emit } = wire();
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.listModels.mockRejectedValueOnce(new Error("model list failed"));

    autoDeps.spawnSummaryFiller(ROOM_PATH, 0);
    await settles(() => expect(report).toHaveBeenCalledWith("summary filler failed:", expect.any(Error)));

    mocks.filesMissingSummary.mockReturnValue([["file-1", "One.txt", "text/plain", "sample"]]);
    autoDeps.spawnSummaryFiller(ROOM_PATH, 0);
    await settles(() => expect(emit).toHaveBeenCalledWith("room-files-changed", {}));
  });
});
