import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  availableName: vi.fn(() => "Video title.md"),
  bestLocalDefault: vi.fn(() => "fake-model"),
  checkpointJob: vi.fn(),
  createJob: vi.fn(() => "job-1"),
  fetchReadable: vi.fn(),
  findFileLike: vi.fn(() => ["file-1", "notes.md"]),
  gatedWrite: vi.fn(),
  getFileExtractedText: vi.fn(() => ""),
  getFileMeta: vi.fn(() => ({ name: "Video title.md" })),
  getJob: vi.fn(() => ({ status: "running", error: null })),
  listModels: vi.fn(async () => ["fake-model"]),
  modelSetting: vi.fn(() => null),
  planSetCellsWorkspace: vi.fn(),
  planSingleEditWorkspace: vi.fn(),
  planWriteFileWorkspace: vi.fn(),
  recReadExtra: undefined as undefined | { resolvePassEngine(): Promise<unknown> },
  runScriptFile: vi.fn(async () => "script-job"),
  runsOnThisMac: vi.fn(() => true),
  setFileExtractedText: vi.fn(),
  setJobStatus: vi.fn(),
  sttStatus: vi.fn(),
  youtubeTranscript: vi.fn(),
  youtubeVideoId: vi.fn(),
}));

vi.mock("./browserAgentTools.js", () => ({ createBrowserAgentTool: () => async () => null }));
vi.mock("./editGate.js", () => ({ gatedWrite: mocks.gatedWrite }));
vi.mock("./editMatch.js", () => ({
  countBatchOps: vi.fn(() => ({ edits: 0, renames: 0 })),
  parseBatchOps: vi.fn(() => []),
  planBatch: vi.fn(() => []),
  planBatchWorkspace: vi.fn(async () => []),
  planSetCells: vi.fn(() => []),
  planSetCellsWorkspace: mocks.planSetCellsWorkspace,
  planSingleEdit: vi.fn(() => []),
  planSingleEditWorkspace: mocks.planSingleEditWorkspace,
  planWriteFile: vi.fn(() => []),
  planWriteFileWorkspace: mocks.planWriteFileWorkspace,
}));
vi.mock("./db-host/files.js", () => ({
  availableName: mocks.availableName,
  findFileLike: mocks.findFileLike,
  getFileExtractedText: mocks.getFileExtractedText,
  getFileMeta: mocks.getFileMeta,
  insertFileFromUrl: vi.fn(),
  setFileExtractedText: mocks.setFileExtractedText,
}));
vi.mock("./db-host/jobs.js", () => ({
  checkpointJob: mocks.checkpointJob,
  createJob: mocks.createJob,
  getJob: mocks.getJob,
  listJobs: vi.fn(() => []),
  setJobStatus: mocks.setJobStatus,
}));
vi.mock("./scriptConsent.js", () => ({
  agentListScriptsInRoom: vi.fn(async () => ""),
  clampScriptOutput: vi.fn(() => "script output"),
  scriptOutput: vi.fn(() => "script output"),
}));
vi.mock("./scriptSurfaceIpc.js", () => ({
  createScriptBytesApprovalRequester: vi.fn(),
  runScriptFile: mocks.runScriptFile,
}));
vi.mock("./skillsCmds.js", () => ({ agentRunSkillScript: vi.fn() }));
vi.mock("./mediaDownloadSurfaceIpc.js", () => ({ createDownloadEngineDeps: vi.fn(() => ({})) }));
vi.mock("./jobDownload.js", () => ({ DOWNLOAD_ENGINE_FETCH: "fetch", startDownloadJobInner: vi.fn() }));
vi.mock("./webFetch.js", () => ({
  INLINE_DOWNLOAD_BYTES: 1024,
  downloadToTemp: vi.fn(),
  fetchReadable: mocks.fetchReadable,
  youtubeTranscript: mocks.youtubeTranscript,
  youtubeVideoId: mocks.youtubeVideoId,
}));
vi.mock("./sttTools.js", () => ({ sttStatus: mocks.sttStatus }));
vi.mock("./speechSttSurfaceIpc.js", () => ({ retranscribeFile: vi.fn() }));
vi.mock("./recRead.js", () => ({
  recReadRowStarter: vi.fn((extra) => {
    mocks.recReadExtra = extra;
    return vi.fn();
  }),
  startRecRead: vi.fn(),
}));
vi.mock("./engineRouting.js", () => ({
  listModels: mocks.listModels,
  stripThinkSpans: (text: string) => text,
}));
vi.mock("./ollamaModels.js", () => ({ bestLocalDefault: mocks.bestLocalDefault }));
vi.mock("./gatherContext.js", () => ({ modelSetting: mocks.modelSetting }));
vi.mock("./capabilities.js", () => ({ runsOnThisMac: mocks.runsOnThisMac }));
vi.mock("./ollamaGenerate.js", () => ({ chatStructured: vi.fn(), generate: vi.fn() }));
vi.mock("./toolSpecs.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./toolSpecs.js")>(),
  resolveLocalGenerateModel: vi.fn(),
}));
vi.mock("./jobs.js", () => ({ spawnJobRunner: vi.fn() }));
vi.mock("./jobQueue.js", () => ({
  atCapacity: vi.fn(() => false),
  QUEUE_FULL: "queue full",
  runnerDepsFrom: vi.fn(),
  submit: vi.fn(),
}));
vi.mock("./filePass.js", () => ({ driveFilePass: vi.fn() }));
vi.mock("./visionTools.js", () => ({ locateInImage: vi.fn() }));
vi.mock("./browser/webAccess.js", () => ({ webAccessEnabled: vi.fn(() => true) }));
vi.mock("./privacy.js", () => ({ outboundUrlHides: vi.fn(() => null) }));
vi.mock("./organizeTools.js", () => ({
  execCreateFileWorkspace: vi.fn(),
  execMergeFilesWorkspace: vi.fn(),
  execMoveFileWorkspace: vi.fn(),
  execOrganizeFilesWorkspace: vi.fn(),
  execRenameFileWorkspace: vi.fn(),
  execTrashFilesWorkspace: vi.fn(),
}));

import { createToolEffects } from "./execTool.js";
import { createLiveRuntimeTool } from "./liveRuntimeTools.js";

function plan(name: string) {
  return {
    fileId: "file-1",
    realName: name,
    newBytes: Buffer.from("after"),
    renameTo: null,
    method: "exact",
    count: 1,
    staleness: Buffer.alloc(32),
    before: "before",
    after: "after",
    clipped: false,
  };
}

function fakeRuntime(options: { workspace?: Record<string, unknown>; retranscribe?: () => Promise<void>; queue?: boolean } = {}) {
  const run = vi.fn();
  const conn = { prepare: vi.fn(() => ({ run })) };
  const room = {
    conn,
    name: "Fake room",
    path: "/fake/room.roomai",
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  };
  const state = { room, editPending: new Map(), roomEpoch: 1 };
  const roomDeps = {
    userDataDir: "/fake/user-data",
    spawnRoomServerIfEnabled: vi.fn(),
    ...(options.queue ? { jobQueue: { starters: new Map() } } : {}),
  };
  const emit = vi.fn();
  const runtime = createLiveRuntimeTool({
    state,
    roomDeps,
    userDataDir: "/fake/user-data",
    resourcesPath: null,
    emit,
    browser: {} as never,
    agentUi: {} as never,
    sttModelState: {} as never,
    retranscribe: options.retranscribe as never,
  });
  return { conn, emit, room, roomDeps, runtime, state };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recReadExtra = undefined;
  mocks.gatedWrite.mockImplementation(async (
    _tool: string,
    _cause: string,
    deps: { rooms: { currentRoom(): { db: unknown; workspace?: unknown } } },
    _effects: unknown,
    compute: (db: unknown, workspace?: unknown) => Promise<unknown[]> | unknown[],
  ) => {
    const current = deps.rooms.currentRoom();
    const plans = await compute(current.db, current.workspace);
    return { kind: "applied", plans };
  });
  mocks.planSingleEditWorkspace.mockResolvedValue([plan("notes.md")]);
  mocks.planWriteFileWorkspace.mockResolvedValue([plan("notes.md")]);
  mocks.planSetCellsWorkspace.mockResolvedValue([plan("table.csv")]);
  mocks.youtubeVideoId.mockReturnValue(null);
  mocks.youtubeTranscript.mockResolvedValue({ title: "Video title", transcript: "Video transcript" });
  mocks.sttStatus.mockReturnValue({ installed: true, downloading: false, sizeMb: 574 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("live runtime edge adapters", () => {
  it("plans dry-run edits, rewrites, and cell changes against workspace bytes", async () => {
    const workspace = { readBuffer: vi.fn() };
    const { runtime } = fakeRuntime({ workspace });

    await expect(runtime("edit_file", {
      name: "notes.md", old_text: "before", new_text: "after", dry_run: true,
    }, createToolEffects())).resolves.toMatchObject({ ok: true, text: expect.stringContaining("Dry run") });
    await expect(runtime("write_file", {
      name: "notes.md", content: "after",
    }, createToolEffects())).resolves.toMatchObject({ ok: true, text: expect.stringContaining("Rewrote") });
    await expect(runtime("set_cells", {
      name: "table.csv", updates: [{ cell: "A1", value: "after" }],
    }, createToolEffects())).resolves.toMatchObject({ ok: true, text: expect.stringContaining("Set A1=after") });

    expect(mocks.planSingleEditWorkspace).toHaveBeenCalledWith(expect.anything(), workspace, expect.anything());
    expect(mocks.planWriteFileWorkspace).toHaveBeenCalledWith(expect.anything(), workspace, "notes.md", "after");
    expect(mocks.planSetCellsWorkspace).toHaveBeenCalledWith(expect.anything(), workspace, "table.csv", null, [["A1", "after"]]);
  });

  it("stores a fetched video transcript through the workspace service", async () => {
    const createFile = vi.fn(async () => ({ fileId: "saved-link" }));
    const { conn, emit, runtime } = fakeRuntime({ workspace: { createFile } });
    mocks.youtubeVideoId.mockReturnValueOnce("video-id");

    await expect(runtime("save_link", { url: "https://video.test/watch?v=video-id" }, createToolEffects())).resolves.toEqual({
      ok: true,
      text: "Saved \"Video title.md\" into the room.",
    });

    expect(mocks.youtubeTranscript).toHaveBeenCalledWith("https://video.test/watch?v=video-id");
    expect(createFile).toHaveBeenCalledWith("Video title.md", expect.anything(), "web");
    expect(mocks.setFileExtractedText).toHaveBeenCalledWith(conn, "saved-link", expect.stringContaining("Video transcript"));
    expect(conn.prepare).toHaveBeenCalledWith(expect.stringContaining("UPDATE files SET origin_url"));
    expect(emit).toHaveBeenCalledWith("room-files-changed", {});
  });

  it("returns a durable background receipt when a script remains running for the wait budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { runtime } = fakeRuntime();

    const pending = runtime("run_script", { name: "notes.md" }, createToolEffects());
    await vi.advanceTimersByTimeAsync(150_000);

    await expect(pending).resolves.toEqual({
      ok: true,
      text: "Started notes.md as background job script-job; it is still running.",
    });
    expect(mocks.getJob).toHaveBeenCalled();
  });

  it("reports downloading state, a live busy name, and a clipped completed transcript", async () => {
    let finish!: () => void;
    const retranscribe = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { runtime } = fakeRuntime({ retranscribe });
    mocks.sttStatus.mockReturnValueOnce({ installed: false, downloading: true, sizeMb: 574 });
    await expect(runtime("stt_status", {}, createToolEffects())).resolves.toEqual({
      ok: true,
      text: "The on-device speech model is still downloading.",
    });
    mocks.sttStatus.mockReturnValueOnce({ installed: false, downloading: true, sizeMb: 574 });
    await expect(runtime("retranscribe_file", { name: "notes.md" }, createToolEffects())).resolves.toEqual({
      ok: false,
      error: "The on-device speech model is still downloading. Try again when it is ready.",
    });

    mocks.sttStatus.mockReturnValue({ installed: true, downloading: false, sizeMb: 574 });
    mocks.getFileExtractedText.mockReturnValue("x".repeat(16_001));
    const pending = runtime("retranscribe_file", { name: "notes.md" }, createToolEffects());
    await vi.waitFor(() => expect(retranscribe).toHaveBeenCalled());
    await expect(runtime("stt_status", {}, createToolEffects())).resolves.toEqual({
      ok: true,
      text: "The on-device speech model is installed and ready. Transcribing notes.md right now.",
    });
    finish();
    await expect(pending).resolves.toMatchObject({
      ok: true,
      text: expect.stringContaining("… (transcript continues in the room file)"),
    });
  });

  it("registers a resumable recording reader whose model resolver stays at the mocked boundary", async () => {
    fakeRuntime({ queue: true });

    await expect(mocks.recReadExtra?.resolvePassEngine()).resolves.toEqual({
      chatModel: "fake-model",
      lane: "local_llm",
    });
    expect(mocks.listModels).toHaveBeenCalledOnce();
    expect(mocks.runsOnThisMac).toHaveBeenCalledWith("fake-model");
  });
});
