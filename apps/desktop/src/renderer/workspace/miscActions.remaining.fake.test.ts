import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  api: {
    approveMcp: vi.fn(),
    getSetting: vi.fn(),
    listFiles: vi.fn(),
    openScratchPad: vi.fn(),
    privacyStatus: vi.fn(),
    resolveEditApproval: vi.fn(),
    resolveMcpCall: vi.fn(),
    setSetting: vi.fn(),
  },
  engineModelLabel: vi.fn(),
  frontPage: vi.fn(),
  frontPageSuggestions: vi.fn(),
  tryToast: vi.fn(),
}));

vi.mock("../api", () => ({
  api: bridge.api,
  engineModelLabel: bridge.engineModelLabel,
  frontPage: bridge.frontPage,
  frontPageSuggestions: bridge.frontPageSuggestions,
}));
vi.mock("./guard", () => ({ tryToast: bridge.tryToast }));
vi.mock("./constants", () => ({ MEMORY_INTRO_SEEN: "memory_intro_seen" }));

import { makeMiscActions } from "./miscActions";

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function actionsFor(state: Record<string, unknown>, info: Record<string, unknown> = {}, viewFile = vi.fn()) {
  return { actions: makeMiscActions(state as never, info as never, { viewFile }), viewFile };
}

beforeEach(() => {
  for (const method of Object.values(bridge.api)) method.mockReset();
  bridge.api.approveMcp.mockResolvedValue([]);
  bridge.api.getSetting.mockResolvedValue(null);
  bridge.api.listFiles.mockResolvedValue([]);
  bridge.api.openScratchPad.mockResolvedValue({ id: "scratch-1" });
  bridge.api.privacyStatus.mockResolvedValue({ effectiveOn: true, pendingFiles: 2, scanning: false });
  bridge.api.resolveEditApproval.mockResolvedValue(undefined);
  bridge.api.resolveMcpCall.mockResolvedValue(undefined);
  bridge.api.setSetting.mockResolvedValue(undefined);
  bridge.engineModelLabel.mockReset().mockImplementation((model: string) => `Fabricated ${model}`);
  bridge.frontPage.mockReset().mockResolvedValue({ suggestions: ["from-page"] });
  bridge.frontPageSuggestions.mockReset().mockResolvedValue(["from-suggestions"]);
  bridge.tryToast.mockReset().mockImplementation(async (state, work, success) => {
    try {
      await work();
      await success?.();
    } catch (error) {
      state.pushToast?.("error", String(error));
    }
  });
});

describe("remaining miscellaneous actions with fabricated boundaries", () => {
  it("refreshes privacy and memory-save state while keeping a failed privacy read unknown", async () => {
    const state = {
      memAutoSaveRef: { current: false },
      setPrivacyOn: vi.fn(),
      setPrivacyPending: vi.fn(),
      setPrivacyScanning: vi.fn(),
    };
    bridge.api.getSetting.mockResolvedValue("1");
    const { actions } = actionsFor(state);

    actions.refreshPrivacy();
    actions.refreshMemAutoSave();
    await flush();
    expect(state.setPrivacyOn).toHaveBeenCalledWith(true);
    expect(state.setPrivacyPending).toHaveBeenCalledWith(2);
    expect(state.setPrivacyScanning).toHaveBeenCalledWith(false);
    expect(state.memAutoSaveRef.current).toBe(true);

    bridge.api.privacyStatus.mockRejectedValueOnce(new Error("fabricated status failure"));
    actions.refreshPrivacy();
    await flush();
    expect(state.setPrivacyOn).toHaveBeenLastCalledWith(null);
  });

  it("opens a fabricated scratch pad and hides the sync warning even if persistence fails", async () => {
    const state = {
      pushToast: vi.fn(),
      setFiles: vi.fn(),
      setShowSyncWarn: vi.fn(),
    };
    const files = [{ id: "scratch-1" }];
    bridge.api.listFiles.mockResolvedValue(files);
    const { actions, viewFile } = actionsFor(state);

    await actions.openScratchPad();
    expect(state.setFiles).toHaveBeenCalledWith(files);
    expect(viewFile).toHaveBeenCalledWith("scratch-1");

    bridge.api.setSetting.mockRejectedValueOnce(new Error("fabricated setting failure"));
    await actions.dismissSyncWarn();
    expect(state.setShowSyncWarn).toHaveBeenCalledWith(false);
    expect(bridge.api.setSetting).toHaveBeenCalledWith("hlt6_sync_dismissed", "1");
  });

  it("approves a fabricated MCP request once and leaves absent or busy requests alone", async () => {
    const state = {
      approvingMcp: false,
      pushToast: vi.fn(),
      setApprovingMcp: vi.fn(),
      setMcpDialogDismissed: vi.fn(),
      setMcpTools: vi.fn(),
    };
    bridge.api.approveMcp.mockResolvedValue([
      { name: "calendar", status: "connected", tools: ["list"] },
      { name: "offline", status: "error", tools: ["never"] },
    ]);
    const { actions } = actionsFor(state, { pendingMcp: { fingerprint: "fake-fingerprint" } });
    await actions.approveMcp();
    expect(bridge.api.approveMcp).toHaveBeenCalledWith("fake-fingerprint");
    expect(state.setMcpTools).toHaveBeenCalledWith(["calendar: list"]);
    expect(state.setMcpDialogDismissed).toHaveBeenCalledWith(true);
    expect(state.setApprovingMcp).toHaveBeenLastCalledWith(false);

    await actionsFor({ approvingMcp: true }, { pendingMcp: { fingerprint: "busy" } }).actions.approveMcp();
    await actionsFor({ approvingMcp: false }).actions.approveMcp();
    expect(bridge.api.approveMcp).toHaveBeenCalledTimes(1);
  });

  it("keeps MCP disabled when the user dismisses the approval prompt", () => {
    const state = { setMcpDialogDismissed: vi.fn() };

    actionsFor(state).actions.keepMcpOff();

    expect(state.setMcpDialogDismissed).toHaveBeenCalledWith(true);
    expect(bridge.api.approveMcp).not.toHaveBeenCalled();
  });

  it("loads fabricated front-page values and resolves MCP and edit approval cards", async () => {
    let suggestions: string[] = [];
    let mcp = [{ id: "mcp-1" }];
    let edits = [{ id: "edit-1" }];
    const state = {
      setEditApprovals: vi.fn((update: (current: typeof edits) => typeof edits) => { edits = update(edits); }),
      setFp: vi.fn(),
      setFpSuggestions: vi.fn((value: string[] | ((current: string[]) => string[])) => {
        suggestions = typeof value === "function" ? value(suggestions) : value;
      }),
      setMcpApprovals: vi.fn((update: (current: typeof mcp) => typeof mcp) => { mcp = update(mcp); }),
    };
    const { actions } = actionsFor(state);
    actions.loadFrontPage(true);
    actions.resolveMcpApproval({ id: "mcp-1" } as never, "always");
    actions.resolveEditApproval({ id: "edit-1" } as never, "turn");
    await flush();

    expect(state.setFp).toHaveBeenCalledWith({ suggestions: ["from-page"] });
    expect(suggestions).toEqual(["from-suggestions"]);
    expect(bridge.api.resolveMcpCall).toHaveBeenCalledWith("mcp-1", "always");
    expect(bridge.api.resolveEditApproval).toHaveBeenCalledWith("edit-1", "turn");
    expect(mcp).toEqual([]);
    expect(edits).toEqual([]);
  });

  it("changes fabricated presentation state, model state, and confirmation state", async () => {
    let engineModels: Record<string, unknown> = {};
    const state = {
      engineModels,
      pushToast: vi.fn(),
      setArea: vi.fn(),
      setConfirmDelete: vi.fn(),
      setEngineModels: vi.fn((update: (current: typeof engineModels) => typeof engineModels) => { engineModels = update(engineModels); }),
      setModel: vi.fn(),
      setOpenFile: vi.fn(),
      setShowMap: vi.fn(),
      setShowScripts: vi.fn(),
      setShowWorkflows: vi.fn(),
      userPickedModelRef: { current: false },
    };
    const { actions } = actionsFor(state);

    actions.revealBrowser();
    await actions.changeModel("fabricated-model");
    actions.recordEngineModels("cloud", [{ id: "fabricated-model" }] as never);
    expect(actions.engineLabelOf("fabricated-model")).toBe("Fabricated fabricated-model");
    actions.askConfirm("delete-1");
    actions.cancelConfirm();

    expect(state.setArea).toHaveBeenCalledWith("browser");
    expect(state.userPickedModelRef.current).toBe(true);
    expect(state.setModel).toHaveBeenCalledWith("fabricated-model");
    expect(bridge.api.setSetting).toHaveBeenCalledWith("model", "fabricated-model");
    expect(engineModels).toEqual({ cloud: [{ id: "fabricated-model" }] });
    expect(state.setConfirmDelete).toHaveBeenNthCalledWith(1, "delete-1");
    expect(state.setConfirmDelete).toHaveBeenNthCalledWith(2, null);
  });
});
