import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  api: {
    approveMcp: vi.fn(),
    updateMemory: vi.fn(),
    listMemories: vi.fn(),
  },
  frontPage: vi.fn(),
  frontPageSuggestions: vi.fn(),
  tryToast: vi.fn(),
}));

vi.mock("../api", () => ({
  api: bridge.api,
  engineModelLabel: () => "Model",
  frontPage: bridge.frontPage,
  frontPageSuggestions: bridge.frontPageSuggestions,
}));
vi.mock("./guard", () => ({ tryToast: bridge.tryToast }));
vi.mock("./constants", () => ({ MEMORY_INTRO_SEEN: "memory_intro_seen" }));

import { makeMiscActions } from "./miscActions";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function state() {
  return { pushToast: vi.fn() };
}

function frontPageState(initialSuggestions: string[]) {
  const value = {
    suggestions: initialSuggestions,
    pushToast: vi.fn(),
    setFp: vi.fn(),
    setFpSuggestions: vi.fn((next: string[] | ((current: string[]) => string[])) => {
      value.suggestions = typeof next === "function" ? next(value.suggestions) : next;
    }),
  };
  return value;
}

function memoryEditState(
  editingMemory: { id: string; content: string; category: string | null } | null,
  memories: unknown[] = ["existing memory"],
) {
  const value = {
    editingMemory,
    memories,
    pushToast: vi.fn(),
    setEditingMemory: vi.fn(
      (next: { id: string; content: string; category: string | null } | null) => {
        value.editingMemory = next;
      },
    ),
    setMemories: vi.fn((next: unknown[]) => {
      value.memories = next;
    }),
  };
  return value;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  bridge.api.approveMcp.mockReset();
  bridge.api.updateMemory.mockReset().mockResolvedValue(undefined);
  bridge.api.listMemories.mockReset().mockResolvedValue([]);
  bridge.frontPage.mockReset().mockResolvedValue({ suggestions: [] });
  bridge.frontPageSuggestions.mockReset().mockResolvedValue([]);
  bridge.tryToast.mockReset().mockImplementation(async (s, run, after) => {
    try {
      await run();
      if (after) await after();
    } catch (error) {
      s.pushToast("error", String(error));
    }
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: vi.fn() } },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {},
  });
});

afterEach(() => {
  vi.clearAllMocks();
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("copyReceipt", () => {
  it("copies every optional location form through a fake clipboard and reports failures", async () => {
    const s = state();
    const actions = makeMiscActions(s as never, {} as never, { viewFile: vi.fn() });
    const writeText = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    writeText.mockResolvedValue(undefined);

    actions.copyReceipt({ fileId: "file", quote: "A page quote", name: "Brief.pdf", page: 4 });
    actions.copyReceipt({ fileId: "file", quote: "A sheet quote", sheet: "Plan" });
    actions.copyReceipt({ fileId: "file", quote: "A range quote", range: "A1:B2" });
    actions.copyReceipt({ fileId: "file", quote: "A room quote" });
    await Promise.resolve();

    expect(writeText.mock.calls.map(([text]) => text)).toEqual([
      '"A page quote"  — Brief.pdf  p. 4',
      '"A sheet quote"  — this room  Plan',
      '"A range quote"  — this room  A1:B2',
      '"A room quote"  — this room',
    ]);
    expect(s.pushToast).toHaveBeenCalledTimes(4);

    writeText.mockRejectedValueOnce(new Error("fake clipboard denial"));
    actions.copyReceipt({ fileId: "file", quote: "Denied" });
    await Promise.resolve();
    expect(s.pushToast).toHaveBeenLastCalledWith(
      "error",
      "Error: fake clipboard denial",
    );
  });
});

describe("playSealSound", () => {
  it("builds the short fabricated seal envelope, closes it after playback, and tolerates unavailable audio", async () => {
    const close = vi.fn(async () => undefined);
    const gain = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    gain.connect.mockReturnValue(gain);
    const oscillator = {
      type: "" as OscillatorType,
      frequency: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null as (() => void) | null,
    };
    oscillator.connect.mockReturnValue(gain);
    const context = {
      currentTime: 2,
      destination: {},
      createOscillator: vi.fn(() => oscillator),
      createGain: vi.fn(() => gain),
      close,
    };
    class FakeAudioContext {
      currentTime = context.currentTime;
      destination = context.destination;
      createOscillator = context.createOscillator;
      createGain = context.createGain;
      close = context.close;
    }
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { AudioContext: FakeAudioContext },
    });
    const actions = makeMiscActions(state() as never, {} as never, { viewFile: vi.fn() });

    actions.playSealSound();
    expect(oscillator.type).toBe("sine");
    expect(oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(420, 2);
    expect(oscillator.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(170, 2.34);
    expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.05, 2.03);
    expect(oscillator.stop).toHaveBeenCalledWith(2.44);
    oscillator.onended?.();
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();

    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    expect(() => actions.playSealSound()).not.toThrow();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { AudioContext: class { constructor() { throw new Error("audio unavailable"); } } },
    });
    expect(() => actions.playSealSound()).not.toThrow();
  });
});

describe("approveMcp", () => {
  it("keeps approval state consistent for successful, rejected, and already-active fabricated requests", async () => {
    const s = {
      approvingMcp: false,
      pushToast: vi.fn(),
      setApprovingMcp: vi.fn((value: boolean) => { s.approvingMcp = value; }),
      setMcpTools: vi.fn(),
      setMcpDialogDismissed: vi.fn(),
    };
    const info = { pendingMcp: { fingerprint: "fake-fingerprint" } };
    const actions = makeMiscActions(s as never, info as never, { viewFile: vi.fn() });
    bridge.api.approveMcp.mockResolvedValueOnce([
      { name: "notes", status: "connected", tools: ["search", "save"] },
      { name: "calendar", status: "disconnected", tools: ["read"] },
    ]);

    await actions.approveMcp();
    expect(bridge.api.approveMcp).toHaveBeenCalledWith("fake-fingerprint");
    expect(s.setMcpTools).toHaveBeenCalledWith(["notes: search", "notes: save"]);
    expect(s.setMcpDialogDismissed).toHaveBeenCalledWith(true);
    expect(s.pushToast).toHaveBeenCalledWith("success", "This room's tools are now allowed on this Mac.");
    expect(s.setApprovingMcp).toHaveBeenNthCalledWith(1, true);
    expect(s.setApprovingMcp).toHaveBeenLastCalledWith(false);

    bridge.api.approveMcp.mockRejectedValueOnce(new Error("fake permission denial"));
    await actions.approveMcp();
    expect(s.pushToast).toHaveBeenLastCalledWith("error", "Error: fake permission denial");
    expect(s.approvingMcp).toBe(false);

    s.approvingMcp = true;
    await actions.approveMcp();
    expect(bridge.api.approveMcp).toHaveBeenCalledTimes(2);
    const noPending = makeMiscActions(s as never, {} as never, { viewFile: vi.fn() });
    await noPending.approveMcp();
    expect(bridge.api.approveMcp).toHaveBeenCalledTimes(2);
  });
});

describe("loadFrontPage", () => {
  it("keeps cached suggestions and fills an empty cache from the fabricated page", async () => {
    const page = { title: "Front page", suggestions: ["from page"] };
    bridge.frontPage.mockResolvedValue(page);

    const cached = frontPageState(["cached"]);
    makeMiscActions(cached as never, {} as never, { viewFile: vi.fn() }).loadFrontPage(false);
    await flushPromises();
    expect(cached.setFp).toHaveBeenCalledWith(page);
    expect(cached.suggestions).toEqual(["cached"]);

    const empty = frontPageState([]);
    makeMiscActions(empty as never, {} as never, { viewFile: vi.fn() }).loadFrontPage(false);
    await flushPromises();
    expect(empty.suggestions).toEqual(["from page"]);

    bridge.frontPage.mockResolvedValueOnce({ title: "No suggestions" });
    const noPageSuggestions = frontPageState([]);
    makeMiscActions(noPageSuggestions as never, {} as never, { viewFile: vi.fn() }).loadFrontPage(false);
    await flushPromises();
    expect(noPageSuggestions.suggestions).toEqual([]);
    expect(bridge.frontPageSuggestions).not.toHaveBeenCalled();
  });

  it("uses nonempty optional suggestions while leaving an empty response alone", async () => {
    bridge.frontPage.mockResolvedValue({ suggestions: ["from page"] });
    bridge.frontPageSuggestions
      .mockResolvedValueOnce(["fetched"])
      .mockResolvedValueOnce([]);

    const fetched = frontPageState([]);
    makeMiscActions(fetched as never, {} as never, { viewFile: vi.fn() }).loadFrontPage(true);
    await flushPromises();
    expect(fetched.suggestions).toEqual(["fetched"]);

    const existing = frontPageState(["cached"]);
    makeMiscActions(existing as never, {} as never, { viewFile: vi.fn() }).loadFrontPage(true);
    await flushPromises();
    expect(existing.suggestions).toEqual(["cached"]);
    expect(bridge.frontPageSuggestions).toHaveBeenCalledTimes(2);
  });

  it("absorbs fabricated front-page and suggestion rejections", async () => {
    bridge.frontPage.mockRejectedValue(new Error("fake page failure"));
    bridge.frontPageSuggestions.mockRejectedValue(new Error("fake suggestion failure"));
    const s = frontPageState([]);
    const actions = makeMiscActions(s as never, {} as never, { viewFile: vi.fn() });

    expect(() => actions.loadFrontPage(true)).not.toThrow();
    await flushPromises();
    expect(s.setFp).not.toHaveBeenCalled();
    expect(s.setFpSuggestions).not.toHaveBeenCalled();
  });
});

describe("saveMemoryEdit", () => {
  it("does nothing without an edit and closes a blank fabricated edit without saving", async () => {
    const absent = memoryEditState(null);
    await makeMiscActions(absent as never, {} as never, { viewFile: vi.fn() }).saveMemoryEdit();
    expect(absent.setEditingMemory).not.toHaveBeenCalled();
    expect(bridge.api.updateMemory).not.toHaveBeenCalled();

    const blank = memoryEditState({ id: "m-blank", content: " \n ", category: null });
    await makeMiscActions(blank as never, {} as never, { viewFile: vi.fn() }).saveMemoryEdit();
    expect(blank.editingMemory).toBeNull();
    expect(blank.setEditingMemory).toHaveBeenCalledWith(null);
    expect(bridge.api.updateMemory).not.toHaveBeenCalled();
    expect(blank.memories).toEqual(["existing memory"]);
  });

  it("trims, saves, and refreshes memories through fabricated APIs", async () => {
    const refreshed = [{ id: "m-1", content: "Revised fact", category: "project" }];
    bridge.api.listMemories.mockResolvedValue(refreshed);
    const s = memoryEditState({
      id: "m-1",
      content: "  Revised fact  ",
      category: "project",
    });

    await makeMiscActions(s as never, {} as never, { viewFile: vi.fn() }).saveMemoryEdit();
    expect(bridge.api.updateMemory).toHaveBeenCalledWith("m-1", "Revised fact", "project");
    expect(bridge.api.listMemories).toHaveBeenCalledOnce();
    expect(s.editingMemory).toBeNull();
    expect(s.memories).toEqual(refreshed);
    expect(s.pushToast).not.toHaveBeenCalled();
  });

  it("preserves the displayed memories and reports a fabricated save failure", async () => {
    bridge.api.updateMemory.mockRejectedValue(new Error("fake memory write failure"));
    const s = memoryEditState({ id: "m-1", content: "Edited", category: null });

    await makeMiscActions(s as never, {} as never, { viewFile: vi.fn() }).saveMemoryEdit();
    expect(s.editingMemory).toBeNull();
    expect(s.memories).toEqual(["existing memory"]);
    expect(bridge.api.listMemories).not.toHaveBeenCalled();
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: fake memory write failure");
  });
});
