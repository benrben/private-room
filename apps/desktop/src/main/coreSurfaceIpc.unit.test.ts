import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomManagerDeps, RoomManagerState } from "./roomManager.js";
import type { EventSender } from "./turn.js";

const mocks = vi.hoisted(() => ({
  activePolicy: vi.fn(),
  appDiag: vi.fn(),
  addPrivacyBlock: vi.fn(),
  connectAiProvider: vi.fn(),
  cancelAsk: vi.fn(),
  declaredFor: vi.fn(),
  effectiveRoomToolNamesWith: vi.fn(),
  feedbackDraft: vi.fn(),
  engineCapabilities: vi.fn(),
  enginePreflight: vi.fn(),
  engineSupportMatrix: vi.fn(),
  listSpecialists: vi.fn(),
  listModels: vi.fn(),
  disconnectAiProvider: vi.fn(),
  loadAgentManifest: vi.fn(),
  liveMcpRoutes: vi.fn(),
  modelSetting: vi.fn(),
  bestLocalDefault: vi.fn(),
  privacyPreview: vi.fn(),
  privacyStatus: vi.fn(),
  removePrivacyEntity: vi.fn(),
  roomToolNamesWith: vi.fn(),
  resolvedBaseUrl: vi.fn(),
  setPrivacyConcepts: vi.fn(),
  setPrivacyGlobal: vi.fn(),
  setPrivacyRoom: vi.fn(),
  sidecarJsonCancellable: vi.fn(),
  startPrivacyScan: vi.fn(),
  toRoomSource: vi.fn(),
  webAccessEnabled: vi.fn(),
}));

vi.mock("./roomManager.js", () => ({ toRoomSource: mocks.toRoomSource }));
vi.mock("./feedbackTools.js", () => ({ appDiag: mocks.appDiag, feedbackDraft: mocks.feedbackDraft }));
vi.mock("./providers.js", () => ({
  connectAiProvider: mocks.connectAiProvider,
  disconnectAiProvider: mocks.disconnectAiProvider,
  ensureProviderCatalog: vi.fn(),
  listAiProviders: vi.fn(),
  providerConnected: vi.fn(),
  providerModelFacts: vi.fn(),
}));
vi.mock("./specialists.js", () => ({ cancelAsk: mocks.cancelAsk, listSpecialists: mocks.listSpecialists }));
vi.mock("./chatCommands.js", () => ({ listChatCommands: vi.fn() }));
vi.mock("./engineRouting.js", () => ({ listModels: mocks.listModels, resolvedBaseUrl: mocks.resolvedBaseUrl }));
vi.mock("./turnContext.js", () => ({ bestDefault: vi.fn() }));
vi.mock("./ollamaModels.js", () => ({ bestLocalDefault: mocks.bestLocalDefault }));
vi.mock("./capabilities.js", () => ({
  declaredFor: mocks.declaredFor,
  engineCapabilities: mocks.engineCapabilities,
  enginePreflight: mocks.enginePreflight,
  engineSupportMatrix: mocks.engineSupportMatrix,
}));
vi.mock("./bridgeDispatcher.js", () => ({
  effectiveRoomToolNamesWith: mocks.effectiveRoomToolNamesWith,
  roomToolNamesWith: mocks.roomToolNamesWith,
  WEB_LANES_ALL: [],
}));
vi.mock("./browser/webAccess.js", () => ({ webAccessEnabled: mocks.webAccessEnabled }));
vi.mock("./gatherContext.js", () => ({ modelSetting: mocks.modelSetting }));
vi.mock("./sidecarJsonCancellable.js", () => ({ sidecarJsonCancellable: mocks.sidecarJsonCancellable }));
vi.mock("./privacy.js", () => ({
  activePolicy: mocks.activePolicy,
  addPrivacyBlock: mocks.addPrivacyBlock,
  privacyPreview: mocks.privacyPreview,
  privacyStatus: mocks.privacyStatus,
  removePrivacyEntity: mocks.removePrivacyEntity,
  setPrivacyConcepts: mocks.setPrivacyConcepts,
  setPrivacyGlobal: mocks.setPrivacyGlobal,
  setPrivacyRoom: mocks.setPrivacyRoom,
  startPrivacyScan: mocks.startPrivacyScan,
}));
vi.mock("./externalDetection.js", () => ({ detectedExternal: vi.fn() }));
vi.mock("./liveAppServices.js", () => ({ liveMcpRoutes: mocks.liveMcpRoutes }));
vi.mock("./harness/agentManifest.js", () => ({ loadAgentManifest: mocks.loadAgentManifest }));

import { registerCoreSurfaceIpc, specialistEffectiveToolNames } from "./coreSurfaceIpc.js";

type Handler = (event: IpcMainInvokeEvent, raw?: unknown) => unknown;

function fixture(withRoom = false): { handlers: Map<string, Handler>; roomDeps: RoomManagerDeps; state: RoomManagerState } {
  const handlers = new Map<string, Handler>();
  const roomDeps = {} as RoomManagerDeps;
  const state = {
    cancel: { cancels: new Map() },
    room: withRoom ? { conn: { name: "fake database" } } : null,
    roomEpoch: 1,
  } as unknown as RoomManagerState;
  mocks.toRoomSource.mockReturnValue({ current: () => state.room });
  registerCoreSurfaceIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as Pick<IpcMain, "handle">,
    state,
    "/fake/user-data",
    vi.fn() as EventSender,
    { appVersion: () => "fake-app", osVersion: () => "fake-os" },
    roomDeps,
  );
  return { handlers, roomDeps, state };
}

function handler(handlers: Map<string, Handler>, channel: string): Handler {
  const registered = handlers.get(channel);
  if (!registered) throw new Error(`Missing ${channel}`);
  return registered;
}

function privacyScanCall(roomDeps: RoomManagerDeps) {
  const scan = roomDeps.privacyScan;
  if (!scan) throw new Error("privacy scan dependencies were not installed");
  return scan.privacyScanCall;
}

interface NativeContextLengthDeps {
  ollamaNativeContextLength(model: string): Promise<number | null>;
}

interface SpecialistSettings {
  webEnabled(): boolean;
  explicitModel(): string | undefined;
}

interface SpecialistDeps {
  servedToolNames(model: string, webEnabled: boolean): string[];
  effectiveServedToolNames(model: string, webEnabled: boolean): string[];
  agentToolNames(agentId: string): string[];
  fetchAgents(body: Record<string, unknown>): Promise<unknown>;
}

interface SupportMatrixDeps {
  fetchAgentSupport(body: Record<string, unknown>): Promise<unknown>;
}

interface PreflightDeps {
  ollamaCapabilities(model: string): Promise<string[]>;
}

function captureNativeContextLengthThroughCapabilities(): void {
  mocks.engineCapabilities.mockImplementation(async (_model: string | null, deps: NativeContextLengthDeps) =>
    deps.ollamaNativeContextLength("fabricated-context-model"),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.activePolicy.mockReturnValue(null);
  mocks.connectAiProvider.mockResolvedValue({ connected: true });
  mocks.declaredFor.mockReturnValue({ tier: "fabricated", imageChannel: true });
  mocks.effectiveRoomToolNamesWith.mockReturnValue(["effective-tool"]);
  mocks.liveMcpRoutes.mockReturnValue([]);
  mocks.loadAgentManifest.mockReturnValue({ agents: [{ id: "files.read", tools: ["read_file"] }] });
  mocks.listModels.mockResolvedValue(["installed-model"]);
  mocks.bestLocalDefault.mockReturnValue("installed-model");
  mocks.modelSetting.mockReturnValue("fake-room-model");
  mocks.resolvedBaseUrl.mockReturnValue("http://fabricated-engine.invalid");
  mocks.roomToolNamesWith.mockReturnValue(["served-tool"]);
  mocks.webAccessEnabled.mockReturnValue(true);
});

describe("core IPC helper boundaries with fabricated dependencies", () => {
  it("filters image-only tools from a text-only specialist catalog", () => {
    mocks.declaredFor.mockReturnValue({ tier: "text", imageChannel: false });
    mocks.effectiveRoomToolNamesWith.mockReturnValue([
      "read_file",
      "view_screenshot",
      "browse_look",
    ]);

    expect(specialistEffectiveToolNames("text-model", true, [], false)).toEqual(["read_file"]);
  });

  it("forwards diagnostics, feedback, disconnect, and cancellation handlers", async () => {
    mocks.appDiag.mockReturnValue({ ok: true });
    mocks.feedbackDraft.mockReturnValue({ body: "draft" });
    mocks.disconnectAiProvider.mockResolvedValue(undefined);
    mocks.cancelAsk.mockReturnValue(true);
    const { handlers, state } = fixture();

    expect(handler(handlers, "app_diag")({} as IpcMainInvokeEvent)).toEqual({ ok: true });
    expect(handler(handlers, "feedback_draft")({} as IpcMainInvokeEvent, { text: 42 }))
      .toEqual({ body: "draft" });
    await expect(handler(handlers, "disconnect_ai_provider")(
      {} as IpcMainInvokeEvent,
      { provider: "fabricated" },
    )).resolves.toBeUndefined();
    expect(handler(handlers, "cancel_ask")({} as IpcMainInvokeEvent, { askId: 7 })).toBe(true);

    expect(mocks.feedbackDraft).toHaveBeenCalledWith(expect.any(Object), "42");
    expect(mocks.disconnectAiProvider).toHaveBeenCalledWith("fabricated");
    expect(mocks.cancelAsk).toHaveBeenCalledWith(state.cancel, "7");
  });

  it("normalizes object, null, and scalar IPC arguments before the fake provider call", async () => {
    const { handlers } = fixture();
    const connect = handler(handlers, "connect_ai_provider");

    await expect(connect({} as IpcMainInvokeEvent, { provider: "fake", apiKey: 7 }))
      .resolves.toEqual({ connected: true });
    await expect(connect({} as IpcMainInvokeEvent, null)).resolves.toEqual({ connected: true });
    await expect(connect({} as IpcMainInvokeEvent, 9)).resolves.toEqual({ connected: true });
    expect(mocks.connectAiProvider.mock.calls).toEqual([
      ["fake", "7"],
      ["", ""],
      ["", ""],
    ]);
  });

  it("returns only a fabricated successful privacy sidecar value", async () => {
    const { roomDeps } = fixture();
    mocks.sidecarJsonCancellable.mockResolvedValue({ kind: "value", value: { entities: [] } });

    await expect(privacyScanCall(roomDeps)({ text: "fake text" })).resolves.toEqual({ entities: [] });
    expect(mocks.sidecarJsonCancellable).toHaveBeenCalledWith(
      "/privacy_scan",
      { text: "fake text" },
      expect.objectContaining({ load: expect.any(Function) }),
    );
  });

  it("resolves a preferred guard model only when it is installed", async () => {
    const { roomDeps } = fixture();
    const resolveGuardModel = roomDeps.privacyScan?.resolveGuardModel;
    if (!resolveGuardModel) throw new Error("privacy guard resolver was not installed");

    await expect(resolveGuardModel("installed-model")).resolves.toBe("installed-model");
    await expect(resolveGuardModel("missing-model")).resolves.toBe("installed-model");

    expect(mocks.listModels).toHaveBeenCalledTimes(2);
    expect(mocks.bestLocalDefault).toHaveBeenCalledWith(["installed-model"]);
  });

  it("preserves stopped and coded fake sidecar failures", async () => {
    const { roomDeps } = fixture();
    const call = privacyScanCall(roomDeps);
    mocks.sidecarJsonCancellable
      .mockResolvedValueOnce({ kind: "stopped" })
      .mockResolvedValueOnce({ kind: "error", error: { code: "FAKE_DOWN", error: "fake failure", status: 503 } });

    await expect(call({})).rejects.toThrow("Stopped.");
    await expect(call({})).rejects.toMatchObject({ message: "fake failure", code: "FAKE_DOWN" });
  });
});

describe("core IPC specialist and capability handlers with fabricated dependencies", () => {
  it("builds a specialist catalog from the current fabricated room state", async () => {
    mocks.sidecarJsonCancellable.mockResolvedValue({ kind: "value", value: { agents: ["fake-agent"] } });
    mocks.listSpecialists.mockImplementation(async (settings: SpecialistSettings, deps: SpecialistDeps) => ({
      webEnabled: settings.webEnabled(),
      explicitModel: settings.explicitModel(),
      served: deps.servedToolNames("fake-room-model", true),
      effective: deps.effectiveServedToolNames("fake-room-model", true),
      tools: deps.agentToolNames("files.read"),
      agents: await deps.fetchAgents({ purpose: "fabricated catalog" }),
    }));
    const { handlers } = fixture(true);

    await expect(handler(handlers, "list_specialists")({} as IpcMainInvokeEvent)).resolves.toEqual({
      webEnabled: true,
      explicitModel: "fake-room-model",
      served: ["served-tool"],
      effective: ["effective-tool"],
      tools: ["read_file"],
      agents: { agents: ["fake-agent"] },
    });
    expect(mocks.webAccessEnabled).toHaveBeenCalledWith({ name: "fake database" });
    expect(mocks.sidecarJsonCancellable).toHaveBeenCalledWith(
      "/agents",
      { purpose: "fabricated catalog" },
      expect.anything(),
    );
  });

  it("normalizes a fabricated preflight capability and requires an open room", async () => {
    mocks.enginePreflight.mockImplementation(async (_model: string | null, _capability: string, deps: PreflightDeps) =>
      deps.ollamaCapabilities("fabricated-capability-model"),
    );
    mocks.sidecarJsonCancellable.mockResolvedValue({ kind: "value", value: { capabilities: ["tools", 3] } });
    const { handlers } = fixture(true);

    await expect(handler(handlers, "engine_preflight")({} as IpcMainInvokeEvent, { capability: "vision" }))
      .resolves.toEqual(["tools"]);
    expect(mocks.enginePreflight).toHaveBeenCalledWith(
      "fake-room-model",
      "vision",
      expect.objectContaining({ ollamaCapabilities: expect.any(Function) }),
    );
    expect(mocks.sidecarJsonCancellable).toHaveBeenCalledWith(
      "/capabilities",
      { model: "fabricated-capability-model", base_url: "http://fabricated-engine.invalid" },
      expect.anything(),
    );

    const closed = fixture(false);
    expect(() => handler(closed.handlers, "engine_preflight")({} as IpcMainInvokeEvent, null))
      .toThrow("No room is open.");
  });

  it("routes fabricated engine-support lookup through the sidecar boundary", async () => {
    mocks.engineSupportMatrix.mockImplementation(async (deps: SupportMatrixDeps) =>
      deps.fetchAgentSupport({ feature: "fabricated support" }),
    );
    mocks.sidecarJsonCancellable.mockResolvedValue({ kind: "value", value: { supported: true } });
    const { handlers } = fixture();

    await expect(handler(handlers, "engine_support_matrix")({} as IpcMainInvokeEvent))
      .resolves.toEqual({ supported: true });
    expect(mocks.sidecarJsonCancellable).toHaveBeenCalledWith(
      "/agent_support",
      { feature: "fabricated support" },
      expect.anything(),
    );
  });
});

describe("core IPC privacy handlers with fabricated state", () => {
  it("forwards fabricated privacy status and preview calls", async () => {
    mocks.privacyStatus.mockResolvedValue({ mode: "fabricated" });
    mocks.privacyPreview.mockResolvedValue({ fileId: "file-1", entities: [] });
    const { handlers } = fixture();

    await expect(handler(handlers, "privacy_status")({} as IpcMainInvokeEvent)).resolves.toEqual({ mode: "fabricated" });
    await expect(handler(handlers, "privacy_preview")({} as IpcMainInvokeEvent, { fileId: "file-1" }))
      .resolves.toEqual({ fileId: "file-1", entities: [] });
    expect(mocks.privacyPreview).toHaveBeenCalledWith({ room: expect.anything() }, "file-1");
  });

  it("passes fabricated room and global privacy choices through the shared scan dependencies", async () => {
    mocks.setPrivacyRoom.mockResolvedValue({ mode: "strict" });
    mocks.setPrivacyGlobal.mockResolvedValue({ global: true });
    const { handlers, roomDeps } = fixture();
    const scan = roomDeps.privacyScan;
    if (!scan) throw new Error("missing fabricated scan dependencies");

    await expect(handler(handlers, "set_privacy_room")({} as IpcMainInvokeEvent, { mode: "strict" }))
      .resolves.toEqual({ mode: "strict" });
    await expect(handler(handlers, "set_privacy_global")({} as IpcMainInvokeEvent, { on: true }))
      .resolves.toEqual({ global: true });
    expect(mocks.setPrivacyRoom).toHaveBeenCalledWith(
      { room: expect.anything(), userDataDir: "/fake/user-data" },
      "strict",
      scan,
    );
    expect(mocks.setPrivacyGlobal).toHaveBeenCalledWith(
      { room: expect.anything(), userDataDir: "/fake/user-data" },
      true,
      scan,
    );
  });

  it("normalizes fabricated privacy block and entity identifiers", async () => {
    mocks.addPrivacyBlock.mockResolvedValue({ id: "block-1" });
    mocks.removePrivacyEntity.mockResolvedValue(undefined);
    const { handlers } = fixture();

    await expect(handler(handlers, "add_privacy_block")({} as IpcMainInvokeEvent, { text: 7, category: null }))
      .resolves.toEqual({ id: "block-1" });
    await handler(handlers, "remove_privacy_entity")({} as IpcMainInvokeEvent, { id: 9 });
    expect(mocks.addPrivacyBlock).toHaveBeenCalledWith(
      { room: expect.anything(), userDataDir: "/fake/user-data" },
      "7",
      "",
    );
    expect(mocks.removePrivacyEntity).toHaveBeenCalledWith(
      { room: expect.anything(), userDataDir: "/fake/user-data" },
      "9",
    );
  });

  it("filters fabricated privacy concepts to strings and starts the injected scan", async () => {
    mocks.setPrivacyConcepts.mockResolvedValue({ concepts: ["people", "places"] });
    mocks.startPrivacyScan.mockResolvedValue({ started: true });
    const { handlers, roomDeps } = fixture();
    const scan = roomDeps.privacyScan;
    if (!scan) throw new Error("missing fabricated scan dependencies");

    await expect(handler(handlers, "set_privacy_concepts")(
      {} as IpcMainInvokeEvent,
      { concepts: ["people", 3, null, "places"] },
    )).resolves.toEqual({ concepts: ["people", "places"] });
    await expect(handler(handlers, "start_privacy_scan")({} as IpcMainInvokeEvent)).resolves.toEqual({ started: true });
    expect(mocks.setPrivacyConcepts).toHaveBeenCalledWith(
      { room: expect.anything(), userDataDir: "/fake/user-data" },
      ["people", "places"],
      scan,
    );
    expect(mocks.startPrivacyScan).toHaveBeenCalledWith(scan);
  });
});

describe("engine context length IPC dependency", () => {
  it("passes a finite fabricated context length from the sidecar value through engine capabilities", async () => {
    captureNativeContextLengthThroughCapabilities();
    mocks.sidecarJsonCancellable.mockResolvedValue({ kind: "value", value: { context_length: 32_768 } });
    const { handlers } = fixture(true);

    await expect(handler(handlers, "engine_capabilities")({} as IpcMainInvokeEvent)).resolves.toBe(32_768);
    expect(mocks.modelSetting).toHaveBeenCalledWith({ name: "fake database" });
    expect(mocks.sidecarJsonCancellable).toHaveBeenCalledWith(
      "/context_length",
      { model: "fabricated-context-model", base_url: "http://fabricated-engine.invalid" },
      expect.anything(),
    );
  });

  it.each([
    ["a string", { context_length: "32768" }],
    ["NaN", { context_length: Number.NaN }],
    ["infinity", { context_length: Number.POSITIVE_INFINITY }],
    ["a null property", { context_length: null }],
    ["an object property", { context_length: { value: 32_768 } }],
    ["a null response", null],
  ] as const)("converts malformed fabricated context length %s to null", async (_label, value) => {
    captureNativeContextLengthThroughCapabilities();
    mocks.sidecarJsonCancellable.mockResolvedValue({ kind: "value", value });
    const { handlers } = fixture(true);

    await expect(handler(handlers, "engine_capabilities")({} as IpcMainInvokeEvent)).resolves.toBeNull();
  });

  it("propagates a fabricated sidecar context-length failure through engine capabilities", async () => {
    captureNativeContextLengthThroughCapabilities();
    mocks.sidecarJsonCancellable.mockResolvedValue({
      kind: "error",
      error: { code: "FAKE_CONTEXT_DOWN", error: "fabricated context endpoint unavailable", status: 503 },
    });
    const { handlers } = fixture(true);

    await expect(handler(handlers, "engine_capabilities")({} as IpcMainInvokeEvent)).rejects.toMatchObject({
      message: "fabricated context endpoint unavailable",
      code: "FAKE_CONTEXT_DOWN",
    });
  });
});
