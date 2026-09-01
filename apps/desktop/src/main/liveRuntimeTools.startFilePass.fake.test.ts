import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  atCapacity: vi.fn(),
  browserTool: vi.fn(),
  createBrowserAgentTool: vi.fn(),
  createJob: vi.fn(),
  findFileLike: vi.fn(),
  noop: vi.fn(),
  recReadRowStarter: vi.fn(),
  submit: vi.fn(),
}));

vi.mock("./browserAgentTools.js", () => ({ createBrowserAgentTool: runtime.createBrowserAgentTool }));
vi.mock("./editMatch.js", () => ({
  countBatchOps: runtime.noop,
  parseBatchOps: runtime.noop,
  planBatch: runtime.noop,
  planBatchWorkspace: runtime.noop,
  planSetCells: runtime.noop,
  planSetCellsWorkspace: runtime.noop,
  planSingleEdit: runtime.noop,
  planSingleEditWorkspace: runtime.noop,
  planWriteFile: runtime.noop,
  planWriteFileWorkspace: runtime.noop,
}));
vi.mock("./editGate.js", () => ({ gatedWrite: runtime.noop }));
vi.mock("./db-host/files.js", () => ({
  availableName: runtime.noop,
  findFileLike: runtime.findFileLike,
  getFileExtractedText: runtime.noop,
  getFileMeta: runtime.noop,
  insertFileFromUrl: runtime.noop,
  setFileExtractedText: runtime.noop,
}));
vi.mock("./db-host/jobs.js", () => ({
  checkpointJob: runtime.noop,
  createJob: runtime.createJob,
  getJob: runtime.noop,
  listJobs: runtime.noop,
  setJobStatus: runtime.noop,
}));
vi.mock("./scriptConsent.js", () => ({
  agentListScriptsInRoom: runtime.noop,
  clampScriptOutput: runtime.noop,
  scriptOutput: runtime.noop,
}));
vi.mock("./scriptSurfaceIpc.js", () => ({
  createScriptBytesApprovalRequester: runtime.noop,
  runScriptFile: runtime.noop,
}));
vi.mock("./skillsCmds.js", () => ({ agentRunSkillScript: runtime.noop }));
vi.mock("./mediaDownloadSurfaceIpc.js", () => ({ createDownloadEngineDeps: runtime.noop }));
vi.mock("./jobDownload.js", () => ({ DOWNLOAD_ENGINE_FETCH: "fake-fetch", startDownloadJobInner: runtime.noop }));
vi.mock("./webFetch.js", () => ({
  INLINE_DOWNLOAD_BYTES: 1,
  downloadToTemp: runtime.noop,
  fetchReadable: runtime.noop,
  youtubeTranscript: runtime.noop,
  youtubeVideoId: runtime.noop,
}));
vi.mock("./sttTools.js", () => ({ sttStatus: runtime.noop }));
vi.mock("./speechSttSurfaceIpc.js", () => ({ retranscribeFile: runtime.noop }));
vi.mock("./recRead.js", () => ({ recReadRowStarter: runtime.recReadRowStarter, startRecRead: runtime.noop }));
vi.mock("./engineRouting.js", () => ({ listModels: runtime.noop, stripThinkSpans: runtime.noop }));
vi.mock("./ollamaModels.js", () => ({ bestLocalDefault: runtime.noop }));
vi.mock("./gatherContext.js", () => ({ modelSetting: runtime.noop }));
vi.mock("./capabilities.js", () => ({ runsOnThisMac: runtime.noop }));
vi.mock("./ollamaGenerate.js", () => ({ chatStructured: runtime.noop, generate: runtime.noop }));
vi.mock("./toolSpecs.js", () => ({ resolveLocalGenerateModel: runtime.noop }));
vi.mock("./jobs.js", () => ({ spawnJobRunner: runtime.noop }));
vi.mock("./jobQueue.js", () => ({
  atCapacity: runtime.atCapacity,
  QUEUE_FULL: "The fabricated queue is full.",
  runnerDepsFrom: runtime.noop,
  submit: runtime.submit,
}));
vi.mock("./filePass.js", () => ({ driveFilePass: runtime.noop }));
vi.mock("./visionTools.js", () => ({ locateInImage: runtime.noop }));
vi.mock("./browser/webAccess.js", () => ({ webAccessEnabled: runtime.noop }));
vi.mock("./privacy.js", () => ({ outboundUrlHides: runtime.noop }));
vi.mock("./organizeTools.js", () => ({
  execCreateFileWorkspace: runtime.noop,
  execMergeFilesWorkspace: runtime.noop,
  execMoveFileWorkspace: runtime.noop,
  execOrganizeFilesWorkspace: runtime.noop,
  execRenameFileWorkspace: runtime.noop,
  execTrashFilesWorkspace: runtime.noop,
}));

import { createLiveRuntimeTool } from "./liveRuntimeTools.js";
import type { AgentUiRuntime } from "./agentUiSurfaceIpc.js";
import type { Browser } from "./browser/browser.js";
import type { ToolEffects } from "./execTool.js";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { SttModelState } from "./sttTools.js";

function fakeRuntime(queue: unknown | undefined) {
  const state = {
    room: {
      conn: { label: "fabricated room database" },
      path: "/fabricated/room.roomai",
      name: "Fabricated room",
      password: "not-used",
    },
  } as unknown as RoomManagerState;
  const roomDeps = {
    userDataDir: "/fabricated/user-data",
    spawnRoomServerIfEnabled: vi.fn(),
    ...(queue === undefined ? {} : { jobQueue: queue }),
  } as unknown as RoomManagerDeps;
  const tool = createLiveRuntimeTool({
    state,
    roomDeps,
    userDataDir: "/fabricated/user-data",
    resourcesPath: null,
    emit: vi.fn(),
    browser: {} as Browser,
    agentUi: {} as AgentUiRuntime,
    sttModelState: {} as SttModelState,
  });
  return { state, tool };
}

describe("start_file_pass through createLiveRuntimeTool", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    runtime.browserTool.mockResolvedValue(null);
    runtime.createBrowserAgentTool.mockReturnValue(runtime.browserTool);
    runtime.atCapacity.mockReturnValue(false);
    runtime.findFileLike.mockReturnValue(["fake-file-id", "notes.md"]);
    runtime.createJob.mockReturnValue("fake-job-id");
    runtime.submit.mockResolvedValue(undefined);
    runtime.recReadRowStarter.mockReturnValue(vi.fn());
  });

  it("reports that the fabricated background queue is unavailable without looking up a file", async () => {
    const { tool } = fakeRuntime(undefined);

    await expect(tool("start_file_pass", { name: "notes.md" }, {} as ToolEffects)).resolves.toEqual({
      ok: false,
      error: "The background job queue is unavailable.",
    });
    expect(runtime.findFileLike).not.toHaveBeenCalled();
    expect(runtime.createJob).not.toHaveBeenCalled();
  });

  it("refuses a fabricated full queue before opening the fabricated file", async () => {
    runtime.atCapacity.mockReturnValue(true);
    const queue = { starters: new Map() };
    const { tool, state } = fakeRuntime(queue);

    await expect(tool("start_file_pass", { name: "notes.md" }, {} as ToolEffects)).resolves.toEqual({
      ok: false,
      error: "The fabricated queue is full.",
    });
    expect(runtime.atCapacity).toHaveBeenCalledWith(state.room?.conn);
    expect(runtime.findFileLike).not.toHaveBeenCalled();
    expect(runtime.submit).not.toHaveBeenCalled();
  });

  it("creates and submits a fabricated merge job with the default thorough instruction", async () => {
    const queue = { starters: new Map() };
    const { tool, state } = fakeRuntime(queue);

    await expect(tool("start_file_pass", { name: "notes.md" }, {} as ToolEffects)).resolves.toEqual({
      ok: true,
      text: 'Started a full pass over "notes.md" as job fake-job-id. The result will be saved as a new room file; progress is visible in Jobs.',
    });
    expect(runtime.createJob).toHaveBeenCalledWith(
      state.room?.conn,
      "file_pass",
      "Full pass — notes.md",
      {
        fileId: "fake-file-id",
        fileName: "notes.md",
        instruction: "Summarize this file completely and thoroughly.",
        mode: "merge",
      },
      1,
    );
    expect(runtime.submit).toHaveBeenCalledWith(expect.objectContaining({ starters: expect.any(Map) }), "fake-job-id");
  });

  it("preserves a fabricated custom instruction and stitch mode in the queued plan", async () => {
    const { tool, state } = fakeRuntime({ starters: new Map() });

    await expect(tool(
      "start_file_pass",
      { name: "notes.md", instruction: "  retain citations  ", mode: "stitch" },
      {} as ToolEffects,
    )).resolves.toMatchObject({ ok: true });

    expect(runtime.createJob).toHaveBeenCalledWith(
      state.room?.conn,
      "file_pass",
      "Full pass — notes.md",
      expect.objectContaining({ instruction: "retain citations", mode: "stitch" }),
      1,
    );
  });
});
