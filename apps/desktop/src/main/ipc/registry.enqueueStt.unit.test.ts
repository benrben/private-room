import { beforeEach, describe, expect, it, vi } from "vitest";

type EnqueueStt = (job: { id: string; name: string }) => void;

const mocks = vi.hoisted(() => ({
  chatDeps: undefined as { enqueueStt: EnqueueStt } | undefined,
  duplicateRegistration: false,
  fileRuntimeActions: undefined as { retranscribeImportedFile(fileId: string): Promise<void> } | undefined,
  recActions: undefined as { retranscribe(db: unknown, ctx: unknown, id: string): Promise<unknown> } | undefined,
  videoDeps: undefined as { enqueueStt: EnqueueStt } | undefined,
  videoWarm: vi.fn(),
  transcribe: vi.fn(),
  registerChat: vi.fn(),
  registerVideo: vi.fn(),
  refreshMcp: vi.fn(),
  runtimeAfterProvision: undefined as (() => void | Promise<void>) | undefined,
}));

const noOp = vi.hoisted(() => vi.fn());
const noOpValue = vi.hoisted(() => vi.fn(() => ({})));

vi.mock("../roomManager.js", () => ({
  createRoomManagerState: noOpValue,
  spawnRoomServerIfEnabledNotImplemented: noOp,
  toRoomSource: () => ({ current: () => null }),
}));
vi.mock("../gatherContext.js", () => ({ modelSetting: vi.fn(() => null) }));
vi.mock("../sttTools.js", () => ({
  SttModelState: class SttModelState {},
  registerSttToolsIpc: noOp,
  sttEffectiveModel: vi.fn(() => null),
}));
vi.mock("../mediaTranscribeJob.js", () => ({
  diarizeEffectiveModel: vi.fn(() => null),
  transcribeMediaWithSpeakers: mocks.transcribe,
}));
vi.mock("../peaksTools.js", () => ({ createPeakCache: noOpValue, registerPeaksIpc: noOp }));
vi.mock("../officeTools.js", () => ({ createSlideCache: noOpValue, registerOfficeIpc: noOp }));
vi.mock("../recBridge.js", () => ({
  createRecBridgeCtx: () => ({ state: { liveFileId: null } }),
  recStop: vi.fn(),
}));
vi.mock("../jobQueue.js", () => ({ createJobQueueState: noOpValue, defaultRowStarters: noOpValue }));
vi.mock("../recRead.js", () => ({ startRecRead: vi.fn() }));
vi.mock("../engineRouting.js", () => ({ listModels: vi.fn() }));
vi.mock("../ollamaModels.js", () => ({
  bestLocalDefault: vi.fn(),
  defaultAiStatusDeps: {},
  registerOllamaModelsIpc: noOp,
}));
vi.mock("../capabilities.js", () => ({ runsOnThisMac: vi.fn(() => true) }));
vi.mock("../sidecar.js", () => ({ configureVisualIndexDir: noOp, forgetRoomMemory: noOp }));
vi.mock("../videoVisualIndex.js", () => ({ videoVisualIndex: { warm: mocks.videoWarm } }));
vi.mock("../jobScheduler.js", () => ({ createSchedulerState: noOpValue, startWorkflowRunNotImplemented: noOp }));
vi.mock("../roomServerLive.js", () => ({
  createRemoveDiscovery: noOpValue,
  createRoomServerDeps: noOpValue,
  createSpawnRoomServerIfEnabled: noOp,
  roomServerRoomSource: () => ({ currentRoom: () => null }),
  roomServerSlotOver: vi.fn(() => false),
}));

vi.mock("../roomManagerIpc.js", () => ({
  registerRoomManagerIpc: (ipcMain: { handle(channel: string, handler: () => void): void }) => {
    if (!mocks.duplicateRegistration) return;
    ipcMain.handle("fabricated_duplicate", noOp);
    ipcMain.handle("fabricated_duplicate", noOp);
  },
}));
vi.mock("../roomCheckpoints.js", () => ({ registerRoomCheckpointsIpc: noOp }));
vi.mock("../chatCmds.js", () => ({
  registerChatIpc: (...args: unknown[]) => {
    mocks.registerChat(...args);
    mocks.chatDeps = args[2] as { enqueueStt: EnqueueStt };
  },
}));
vi.mock("../dictStopTimeout.js", () => ({ registerDictIpc: noOp }));
vi.mock("../docxEdit.js", () => ({ registerDocxEditIpc: noOp }));
vi.mock("../editGate.js", () => ({ registerEditGateIpc: noOp }));
vi.mock("../libraryTools.js", () => ({ registerLibraryIpc: noOp }));
vi.mock("../moonshotAiActions.js", () => ({ registerMoonshotAiActionsIpc: noOp }));
vi.mock("../moonshotCmds.js", () => ({ registerMoonshotIpc: noOp }));
vi.mock("../moonshotFrontPage.js", () => ({ registerFrontPageIpc: noOp }));
vi.mock("../moonshotGraph.js", () => ({ registerRoomGraphIpc: noOp }));
vi.mock("../moonshotRoles.js", () => ({ registerRolesIpc: noOp }));
vi.mock("../moonshotServer.js", () => ({ registerMoonshotServerIpc: noOp }));
vi.mock("../externalDetection.js", () => ({ detectedExternal: vi.fn(), ollamaInstalled: vi.fn() }));
vi.mock("../previewTools.js", () => ({ registerPreviewIpc: noOp, renderQuickLook: vi.fn() }));
vi.mock("../recIpc.js", () => ({
  registerRecIpc: (...args: unknown[]) => {
    mocks.recActions = args[3] as typeof mocks.recActions;
  },
}));
vi.mock("../recentTools.js", () => ({ registerRecentIpc: noOp }));
vi.mock("../runtimesCmds.js", () => ({
  registerRuntimesIpc: (...args: unknown[]) => {
    mocks.runtimeAfterProvision = args[3] as typeof mocks.runtimeAfterProvision;
  },
}));
vi.mock("../safetyTools.js", () => ({ registerSafetyIpc: noOp }));
vi.mock("../searchTools.js", () => ({ registerSearchIpc: noOp }));
vi.mock("../sketchIpc.js", () => ({ registerSketchIpc: noOp }));
vi.mock("../skillsCmds.js", () => ({ registerSkillsIpc: noOp }));
vi.mock("../spreadsheetTools.js", () => ({ registerSpreadsheetIpc: noOp }));
vi.mock("../storyTools.js", () => ({ registerStoryIpc: noOp }));
vi.mock("../studiosPodcastAudio.js", () => ({ registerStudiosPodcastAudioIpc: noOp }));
vi.mock("../videoTools.js", () => ({
  registerVideoIpc: (...args: unknown[]) => {
    mocks.registerVideo(...args);
    mocks.videoDeps = args[2] as { enqueueStt: EnqueueStt };
  },
}));
vi.mock("../visionTools.js", () => ({ registerVisionIpc: noOp }));
vi.mock("../workflowCompose.js", () => ({
  generateTextAnyEngine: vi.fn(),
  registerWorkflowComposeIpc: noOp,
  withRealOllamaGenerate: noOpValue,
}));
vi.mock("../dialogTools.js", () => ({ registerDialogIpc: noOp }));
vi.mock("../shellTools.js", () => ({ registerShellIpc: noOp }));
vi.mock("../coreSurfaceIpc.js", () => ({ registerCoreSurfaceIpc: noOp }));
vi.mock("../fileSurfaceIpc.js", () => ({ registerFileSurfaceIpc: noOp }));
vi.mock("../mcpSurfaceIpc.js", () => ({
  createMcpRuntime: () => ({ manager: {} }),
  registerMcpSurfaceIpc: noOp,
}));
vi.mock("../browserSurfaceIpc.js", () => ({ registerBrowserSurfaceIpc: noOpValue }));
vi.mock("../jobWorkflowSurfaceIpc.js", () => ({ registerJobWorkflowSurfaceIpc: noOp }));
vi.mock("../fileRuntimeSurfaceIpc.js", () => ({
  registerFileRuntimeSurfaceIpc: (...args: unknown[]) => {
    mocks.fileRuntimeActions = args[6] as typeof mocks.fileRuntimeActions;
    return {};
  },
}));
vi.mock("../mediaDownloadSurfaceIpc.js", () => ({ registerMediaDownloadSurfaceIpc: noOp }));
vi.mock("../scriptSurfaceIpc.js", () => ({ registerScriptSurfaceIpc: noOp }));
vi.mock("../modelCatalogSurfaceIpc.js", () => ({ registerModelCatalogSurfaceIpc: noOp }));
vi.mock("../speechSttSurfaceIpc.js", () => ({ registerSpeechSttSurfaceIpc: noOp }));
vi.mock("../chatTurnSurfaceIpc.js", () => ({ registerChatTurnSurfaceIpc: noOp }));
vi.mock("../workflowAgentRun.js", () => ({ createWorkflowAgentRun: noOp }));
vi.mock("../agentUiSurfaceIpc.js", () => ({ registerAgentUiSurfaceIpc: noOpValue }));
vi.mock("../creativeJobSurfaceIpc.js", () => ({ registerCreativeJobSurfaceIpc: noOp }));
vi.mock("../harnessSurfaceIpc.js", () => ({ registerHarnessSurfaceIpc: noOp }));
vi.mock("../autoIndexLive.js", () => ({ createLiveAutoIndex: noOp }));
vi.mock("../liveAppServices.js", () => ({ refreshMcpConnections: mocks.refreshMcp }));
vi.mock("../retrievalBackfill.js", () => ({
  createEmbedBackfillState: noOpValue,
  spawnEmbeddingBackfill: noOp,
  spawnLegacyTextRepair: noOp,
  spawnReextractBackfill: noOp,
}));
vi.mock("../documentExtraction.js", () => ({ extractDocumentText: vi.fn() }));
vi.mock("../chatCommands.js", () => ({ runCommand: vi.fn() }));
vi.mock("../liveContext.js", () => ({ assembleLiveContext: () => ({ runCommandDeps: {} }) }));

import { registerAllIpc } from "./registry.js";

function registerWithFakes(emitted: [string, unknown][]): void {
  registerAllIpc({
    ipcMain: { handle: vi.fn() },
    state: {
      room: null,
      roomEpoch: 0,
      rollingBack: false,
      editPending: new Map(),
      cancel: {},
    } as never,
    deps: {} as never,
    host: {
      setUnsavedEdits: noOp,
      rearmQuitGuard: noOp,
      confirmQuit: noOp,
      syncMenu: noOp,
      appVersion: () => "fake",
      osVersion: () => "fake",
      checkForUpdate: async () => null,
      installUpdate: async () => undefined,
      windowContentView: () => null,
      focusMainWindow: noOp,
      openPath: async () => undefined,
    },
    dialog: {} as never,
    shell: {
      shell: {
        openExternal: async () => undefined,
        trashItem: async () => undefined,
      },
    } as never,
    emit: (event, payload) => emitted.push([event, payload]),
    userDataDir: "/fabricated-user-data",
    resourcesPath: null,
  });
}

async function flushRejectedEnqueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chatDeps = undefined;
  mocks.duplicateRegistration = false;
  mocks.fileRuntimeActions = undefined;
  mocks.recActions = undefined;
  mocks.runtimeAfterProvision = undefined;
  mocks.videoDeps = undefined;
});

describe("registry runtime reconnect wiring with fabricated registrars", () => {
  it("refreshes room connectors after a runtime is provisioned", async () => {
    registerWithFakes([]);

    expect(mocks.runtimeAfterProvision).toBeTypeOf("function");
    await mocks.runtimeAfterProvision?.();

    expect(mocks.refreshMcp).toHaveBeenCalledOnce();
  });
});

describe("registry speaker-aware transcription wiring with fabricated registrars", () => {
  it("reports a named failure when chat import transcription unexpectedly rejects", async () => {
    const emitted: [string, unknown][] = [];
    mocks.transcribe.mockRejectedValueOnce(new Error("chat decode failed"));

    registerWithFakes(emitted);
    mocks.chatDeps?.enqueueStt({ id: "chat-file", name: "chat-recording.mp3" });
    await flushRejectedEnqueue();

    expect(mocks.registerChat).toHaveBeenCalledTimes(1);
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.any(Object), "chat-file");
    expect(emitted).toEqual([[
      "stt-progress",
      ["chat-recording.mp3", "failed: chat decode failed"],
    ]]);
  });

  it("uses the same name-keyed failure protocol for trimmed-video transcription", async () => {
    const emitted: [string, unknown][] = [];
    mocks.transcribe.mockRejectedValueOnce("video decoder unavailable");

    registerWithFakes(emitted);
    mocks.videoDeps?.enqueueStt({ id: "trim-file", name: "trimmed-video.mp4" });
    await flushRejectedEnqueue();

    expect(mocks.registerVideo).toHaveBeenCalledTimes(1);
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.any(Object), "trim-file");
    expect(emitted).toEqual([[
      "stt-progress",
      ["trimmed-video.mp4", "failed: video decoder unavailable"],
    ]]);
  });

  it("forwards visual-index warming and imported-file retranscription through fabricated boundaries", async () => {
    mocks.transcribe.mockResolvedValue({ durationCs: 12 });
    mocks.videoWarm.mockResolvedValue({ warmed: true });
    registerWithFakes([]);

    mocks.chatDeps?.enqueueStt({ id: "chat-file", name: "chat-recording.mp3" });
    await flushRejectedEnqueue();
    const mediaDeps = mocks.transcribe.mock.calls[0]?.[0] as {
      warmVisualIndex(path: string, sha: string, timeout: number): Promise<unknown>;
    };
    await expect(mediaDeps.warmVisualIndex("/fake/staged", "source-sha", 123)).resolves.toEqual({ warmed: true });
    expect(mocks.videoWarm).toHaveBeenCalledWith("/fake/staged", "source-sha", 123);

    await expect(mocks.fileRuntimeActions?.retranscribeImportedFile("imported-file"))
      .resolves.toBeUndefined();
    expect(mocks.transcribe).toHaveBeenCalledWith(expect.any(Object), "imported-file");
  });

  it("returns successful fabricated retranscription metadata to the recording IPC", async () => {
    const meta = { durationCs: 42, speakers: [] };
    mocks.transcribe.mockResolvedValue(meta);
    registerWithFakes([]);

    await expect(mocks.recActions?.retranscribe({}, {}, "recording-file")).resolves.toBe(meta);
  });

  it("rejects a duplicate channel even when the underlying fake IPC is permissive", () => {
    mocks.duplicateRegistration = true;

    expect(() => registerWithFakes([])).toThrow('registry: channel "fabricated_duplicate" was registered twice');
  });
});
