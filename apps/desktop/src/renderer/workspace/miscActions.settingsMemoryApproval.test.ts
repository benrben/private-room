import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  api: {
    addMemory: vi.fn(),
    getSetting: vi.fn(),
    listMemories: vi.fn(),
    resolveAgentUi: vi.fn(),
    resolveEditApproval: vi.fn(),
    setSetting: vi.fn(),
  },
  tryToast: vi.fn(),
}));

vi.mock("../api", () => ({
  api: bridge.api,
  engineModelLabel: vi.fn(),
  frontPage: vi.fn(),
  frontPageSuggestions: vi.fn(),
}));
vi.mock("./guard", () => ({ tryToast: bridge.tryToast }));
vi.mock("./constants", () => ({ MEMORY_INTRO_SEEN: "memory_intro_seen" }));

import { makeMiscActions } from "./miscActions";

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function actionsFor(state: Record<string, unknown>) {
  return makeMiscActions(state as never, {} as never, { viewFile: vi.fn() });
}

beforeEach(() => {
  for (const method of Object.values(bridge.api)) method.mockReset();
  bridge.api.addMemory.mockResolvedValue(undefined);
  bridge.api.getSetting.mockResolvedValue(null);
  bridge.api.listMemories.mockResolvedValue([]);
  bridge.api.resolveAgentUi.mockResolvedValue(undefined);
  bridge.api.resolveEditApproval.mockResolvedValue(undefined);
  bridge.api.setSetting.mockResolvedValue(undefined);
  bridge.tryToast.mockReset().mockImplementation(async (state, work, after) => {
    try {
      await work();
      await after?.();
    } catch (error) {
      state.pushToast("error", String(error));
    }
  });
});

describe("misc action settings with fabricated APIs", () => {
  it("maps fabricated web, advisor, and autolock settings into workspace state", async () => {
    const values: Record<string, string | null> = {
      advisor_tools_enabled: "on",
      autolock_minutes: null,
      web_provider: "search-provider",
    };
    bridge.api.getSetting.mockImplementation((key: string) => Promise.resolve(values[key]));
    const state = {
      autolockRef: { current: "" },
      setAdvisorToolsOn: vi.fn(),
      setWebOn: vi.fn(),
    };
    const actions = actionsFor(state);

    actions.refreshWebAccess();
    actions.refreshAutolock();
    await flushPromises();
    expect(state.setWebOn).toHaveBeenLastCalledWith(true);
    expect(state.setAdvisorToolsOn).toHaveBeenLastCalledWith(true);
    expect(state.autolockRef.current).toBe("15");

    values.web_provider = "off";
    values.advisor_tools_enabled = "0";
    values.autolock_minutes = "25";
    actions.refreshWebAccess();
    actions.refreshAutolock();
    await flushPromises();
    expect(state.setWebOn).toHaveBeenLastCalledWith(false);
    expect(state.setAdvisorToolsOn).toHaveBeenLastCalledWith(false);
    expect(state.autolockRef.current).toBe("25");
  });
});

describe("misc memory actions with fabricated storage", () => {
  it("saves a suggested fact, enables auto-save, and keeps an empty suggestion inert", async () => {
    const memories = [{ id: "memory-1", content: "Fabricated fact" }];
    bridge.api.listMemories.mockResolvedValue(memories);
    const suggested = {
      memSuggestion: { fact: "Fabricated fact" },
      pushToast: vi.fn(),
      setMemSuggestion: vi.fn(),
      setMemories: vi.fn(),
    };

    await actionsFor(suggested).saveSuggestedMemory();
    expect(suggested.setMemSuggestion).toHaveBeenCalledWith(null);
    expect(bridge.api.addMemory).toHaveBeenCalledWith("Fabricated fact");
    expect(suggested.setMemories).toHaveBeenCalledWith(memories);
    expect(suggested.pushToast).toHaveBeenCalledWith("success", "Saved to memory.");

    bridge.api.addMemory.mockClear();
    const automatic = {
      memAutoSaveRef: { current: false },
      memSuggestion: { fact: "Another fabricated fact" },
      pushToast: vi.fn(),
      setMemSuggestion: vi.fn(),
      setMemories: vi.fn(),
    };
    await actionsFor(automatic).enableMemoryAutoSave();
    expect(automatic.memAutoSaveRef.current).toBe(true);
    expect(bridge.api.setSetting).toHaveBeenCalledWith("memory_auto_save", "1");
    expect(bridge.api.addMemory).toHaveBeenCalledWith("Another fabricated fact");
    expect(automatic.setMemories).toHaveBeenCalledWith(memories);

    bridge.api.addMemory.mockClear();
    await actionsFor({ memSuggestion: null }).saveSuggestedMemory();
    expect(bridge.api.addMemory).not.toHaveBeenCalled();
  });

  it("stores a fabricated draft only when it has content and preserves it after a failure", async () => {
    const blank = { memoryDraft: "  ", memoryDraftCat: "work" };
    await actionsFor(blank).addMemory();
    expect(bridge.api.addMemory).not.toHaveBeenCalled();

    const saved = {
      memoryDraft: "Fabricated draft",
      memoryDraftCat: "work",
      pushToast: vi.fn(),
      setMemories: vi.fn(),
      setMemoryDraft: vi.fn(),
      setMemoryDraftCat: vi.fn(),
    };
    bridge.api.listMemories.mockResolvedValue(["fresh memory"]);
    await actionsFor(saved).addMemory();
    expect(bridge.api.addMemory).toHaveBeenCalledWith("Fabricated draft", "work");
    expect(saved.setMemories).toHaveBeenCalledWith(["fresh memory"]);
    expect(saved.setMemoryDraft).toHaveBeenCalledWith("");
    expect(saved.setMemoryDraftCat).toHaveBeenCalledWith("");

    bridge.api.addMemory.mockRejectedValueOnce(new Error("fabricated memory failure"));
    const failed = {
      memoryDraft: "Retry this",
      memoryDraftCat: "",
      pushToast: vi.fn(),
      setMemories: vi.fn(),
      setMemoryDraft: vi.fn(),
      setMemoryDraftCat: vi.fn(),
    };
    await actionsFor(failed).addMemory();
    expect(failed.setMemoryDraft).not.toHaveBeenCalled();
    expect(failed.pushToast).toHaveBeenCalledWith("error", "Error: fabricated memory failure");
  });
});

describe("misc approval actions with fabricated host responses", () => {
  it("removes browse consent cards while reporting only a failed fabricated approval", async () => {
    let consents: Array<{ id: string }> = [{ id: "allow" }];
    const state = {
      pushToast: vi.fn(),
      setBrowseConsents: vi.fn((update: (current: typeof consents) => typeof consents) => {
        consents = update(consents);
      }),
    };
    bridge.api.resolveAgentUi.mockRejectedValueOnce(new Error("fabricated expired approval"));

    actionsFor(state).resolveBrowseConsent({ id: "allow" } as never, true);
    await flushPromises();
    expect(consents).toEqual([]);
    expect(state.pushToast).toHaveBeenCalledWith("error", "Error: fabricated expired approval");

    consents = [{ id: "deny" }];
    bridge.api.resolveAgentUi.mockRejectedValueOnce(new Error("fabricated deny expiry"));
    actionsFor(state).resolveBrowseConsent({ id: "deny" } as never, false);
    await flushPromises();
    expect(consents).toEqual([]);
    expect(state.pushToast).toHaveBeenCalledTimes(1);
  });

  it("keeps permanent edit approval state honest for fabricated success and failure", async () => {
    let approvals: Array<{ id: string }> = [{ id: "edit-1" }];
    const state = {
      pushToast: vi.fn(),
      setEditApprovals: vi.fn((update: (current: typeof approvals) => typeof approvals) => {
        approvals = update(approvals);
      }),
    };
    const actions = actionsFor(state);

    await actions.alwaysAllowEdits({ id: "edit-1" } as never);
    expect(bridge.api.setSetting).toHaveBeenCalledWith("edit_approval", "off");
    expect(bridge.api.resolveEditApproval).toHaveBeenCalledWith("edit-1", "once");
    expect(approvals).toEqual([]);
    expect(state.pushToast).toHaveBeenCalledWith("success", expect.stringContaining("now allowed"));

    bridge.api.setSetting.mockRejectedValueOnce(new Error("fabricated setting failure"));
    approvals = [{ id: "edit-2" }];
    await actions.alwaysAllowEdits({ id: "edit-2" } as never);
    expect(bridge.api.resolveEditApproval).toHaveBeenCalledTimes(1);
    expect(approvals).toEqual([{ id: "edit-2" }]);
    expect(state.pushToast).toHaveBeenLastCalledWith(
      "error",
      "Couldn't save the permanent permission: Error: fabricated setting failure",
    );
  });
});
