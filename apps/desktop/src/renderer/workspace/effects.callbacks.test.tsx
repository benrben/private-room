import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  const listeners = new Map<string, (...args: any[]) => any>();
  const methods = new Map<string, ReturnType<typeof vi.fn>>();
  const api = new Proxy({}, {
    get(_target, property) {
      const name = String(property);
      const existing = methods.get(name);
      if (existing) return existing;
      const method = name.startsWith("on")
        ? vi.fn((listener: (...args: any[]) => any) => {
            listeners.set(name, listener);
            return Promise.resolve(vi.fn());
          })
        : vi.fn(() => Promise.resolve(name === "harnessListRuns" ? [] : null));
      methods.set(name, method);
      return method;
    },
  });
  return {
    api,
    listeners,
    methods,
    handleAgentUiRequest: vi.fn(),
    applyRecState: vi.fn(),
    startRecordingTransport: vi.fn(),
    stopMicTap: vi.fn(),
  };
});

vi.mock("../api", () => ({ api: fakes.api }));
vi.mock("../platform", () => ({
  listen: vi.fn((event: string, listener: (...args: any[]) => any) => {
    fakes.listeners.set(`listen:${event}`, listener);
    return Promise.resolve(vi.fn());
  }),
  onDragDropEvent: vi.fn((listener: (...args: any[]) => any) => {
    fakes.listeners.set("onDragDropEvent", listener);
    return Promise.resolve(vi.fn());
  }),
  setWindowTitle: vi.fn(() => Promise.resolve()),
}));
vi.mock("./liveRec", () => ({
  configureMic: vi.fn(),
  micVoiceProcessingFromSetting: () => false,
  stopMicTap: fakes.stopMicTap,
}));
vi.mock("../agent/driver", () => ({
  handleAgentUiRequest: fakes.handleAgentUiRequest,
}));
vi.mock("./markup", () => ({ annotationTarget: (payload: unknown) => payload }));
vi.mock("./constants", () => ({ MEMORY_INTRO_SEEN: "memory_intro_seen" }));
vi.mock("./voice", () => ({
  cancelAll: vi.fn(),
  setTurnAudioDoneListener: vi.fn((listener: (...args: any[]) => any) => {
    fakes.listeners.set("voiceAudioDone", listener);
  }),
  setVoiceProblemListener: vi.fn(),
  turnBelongsTo: vi.fn(() => false),
  feedStreamDelta: vi.fn(),
  roundBoundary: vi.fn(),
}));
vi.mock("./runIdentity", () => ({ ownerOf: (turn: { chatId?: string }) => turn.chatId ?? null }));
vi.mock("./recSession", () => ({ applyRecState: fakes.applyRecState }));
vi.mock("./recordingTransport", () => ({ startRecordingTransport: fakes.startRecordingTransport }));
vi.mock("./harnessUi", () => ({
  applyHarnessEvent: (runs: unknown[], event: unknown) => [...runs, event],
  mergeHarnessHistory: (runs: unknown[], history: unknown[]) => [...runs, ...history],
}));
vi.mock("./harnessFileRefresh", () => ({ refreshSharedFilesForHarnessEvent: vi.fn(async () => undefined) }));

import { useWorkspaceEffects } from "./effects";
import * as voice from "./voice";

const { act, createElement } = React;
const globalKeys = ["document", "window", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function callback(name: string) {
  const listener = fakes.listeners.get(name);
  if (!listener) throw new Error(`${name} listener missing`);
  return listener;
}

function workspaceState() {
  const fallback = new Map<string, unknown>();
  const store = {
    browseConsents: [] as unknown[],
    harnessRuns: [] as unknown[],
    updatedRun: null as Record<string, unknown> | null,
  };
  const state: Record<string, any> = {
    seededRef: { current: true },
    activeChatId: null,
    activeChatIdRef: { current: "chat-1" },
    asking: false,
    askingRef: { current: false },
    handsFreeRef: { current: false },
    dictStateRef: { current: "idle" },
    armTimerRef: { current: null },
    editedRef: { current: new Set<string>() },
    openFileRef: { current: { id: "file-1", content: { name: "File" } } },
    editModeRef: { current: false },
    editorDirtyRef: { current: false },
    prevModelRef: { current: "old-model" },
    userPickedModelRef: { current: false },
    model: "new-model",
    openFile: null,
    ctxMenu: null,
    moveMenuFor: null,
    showSearch: false,
    searchQuery: "",
    messages: [],
    streamText: "",
    agentPlan: null,
    setBrowseConsents: vi.fn((update: (items: unknown[]) => unknown[]) => {
      store.browseConsents = update(store.browseConsents);
    }),
    setHarnessRuns: vi.fn((update: (runs: unknown[]) => unknown[]) => {
      store.harnessRuns = update(store.harnessRuns);
    }),
    applyToRun: vi.fn((_chat: string, _runId: string, update: (run: Record<string, unknown>) => Record<string, unknown>) => {
      store.updatedRun = update({
        text: "",
        steps: [{ label: "global", ok: true }],
        agentSteps: { worker: [{ label: "worker", ok: true }] },
      });
    }),
    pushToast: vi.fn(),
    setAiTab: vi.fn(),
    setFiles: vi.fn(),
    setStaleFile: vi.fn(),
    setOpenFile: vi.fn(),
    setViewerRev: vi.fn(),
    engineLabelOf: vi.fn(),
  };
  return {
    state: new Proxy(state, {
      get(target, property) {
        const name = String(property);
        if (name in target) return target[name];
        if (fallback.has(name)) return fallback.get(name);
        const value = name.endsWith("Ref")
          ? { current: null }
          : name.startsWith("set")
            ? vi.fn()
            : vi.fn();
        fallback.set(name, value);
        return value;
      },
    }),
    store,
  };
}

function workspaceActions() {
  const actions: Record<string, any> = {
    connectedTools: vi.fn(() => []),
    engineLabelOf: vi.fn((model: string) => `Engine ${model}`),
  };
  return new Proxy(actions, {
    get(target, property) {
      const name = String(property);
      if (!(name in target)) target[name] = vi.fn();
      return target[name];
    },
  });
}

function EffectsProbe({ state, actions, synced = false }: { state: unknown; actions: unknown; synced?: boolean }) {
  useWorkspaceEffects(
    state as never,
    actions as never,
    { name: "Fake room", path: "/fake/room", synced } as never,
    vi.fn(),
  );
  return null;
}

async function renderEffects(configure?: (state: Record<string, any>) => void, synced = false) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(window, "setInterval", vi.fn(() => 1));
  Reflect.set(window, "clearInterval", vi.fn());
  const timers: Array<{ callback: () => void; delay: number; id: number }> = [];
  Reflect.set(window, "setTimeout", vi.fn((callback: () => void, delay: number) => {
    const timer = { callback, delay, id: timers.length + 1 };
    timers.push(timer);
    return timer.id;
  }));
  Reflect.set(window, "clearTimeout", vi.fn());
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const { state, store } = workspaceState();
  const actions = workspaceActions();
  configure?.(state);
  const render = async () => act(async () => {
    root.render(createElement(EffectsProbe, { state, actions, synced }));
    await Promise.resolve();
    await Promise.resolve();
  });
  await render();
  return { actions, render, root, state, store, timers };
}

afterEach(() => {
  vi.clearAllMocks();
  fakes.listeners.clear();
  fakes.methods.clear();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("workspace effect callback seams", () => {
  it("reports failed room reads and keeps late navigation, activity, chat, and cleanup callbacks live", async () => {
    fakes.methods.set("listChats", vi.fn().mockResolvedValue([]));
    fakes.methods.set("createChat", vi.fn().mockResolvedValue({ id: "created" }));
    fakes.methods.set("listFiles", vi.fn().mockRejectedValue(new Error("files unavailable")));
    fakes.methods.set("getMessages", vi.fn().mockRejectedValue(new Error("messages unavailable")));
    const view = await renderEffects((state) => {
      state.seededRef.current = false;
      state.activeChatId = "chat-1";
      state.prevAskingRef.current = true;
      state.asking = false;
      state.lastActivityRef.current = 0;
      state.armTimerRef.current = 77;
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.state.pushToast).toHaveBeenCalledWith("error", "Could not read this room's files: Error: files unavailable");
    expect(view.state.pushToast).toHaveBeenCalledWith("error", "Could not read this conversation: Error: messages unavailable");
    expect(view.state.lastActivityRef.current).toBeGreaterThan(0);

    await act(async () => {
      callback("onAgentOpenFile")("file-2");
      callback("onAgentAnnotate")({ fileId: "file-3", find: "needle" });
      window.dispatchEvent(new window.Event("click"));
      const interval = vi.mocked(window.setInterval).mock.calls[0]?.[0] as (() => void) | undefined;
      interval?.();
    });
    expect(view.actions.viewFile).toHaveBeenNthCalledWith(1, "file-2");
    expect(view.actions.viewFile).toHaveBeenNthCalledWith(2, "file-3", { fileId: "file-3", find: "needle" });

    await act(async () => view.root.unmount());
    expect(window.clearTimeout).toHaveBeenCalledWith(77);
    expect(view.state.armTimerRef.current).toBeNull();
  });

  it("creates or selects fabricated initial conversations without using a live room", async () => {
    fakes.methods.set("listChats", vi.fn().mockResolvedValue([]));
    fakes.methods.set("createChat", vi.fn().mockResolvedValue({ id: "chat-created" }));
    const empty = await renderEffects((state) => { state.seededRef.current = false; });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(empty.state.setChats).toHaveBeenCalledWith([{ id: "chat-created" }]);
    expect(empty.state.setActiveChatId).toHaveBeenCalledWith("chat-created");
    await act(async () => empty.root.unmount());

    fakes.methods.set("listChats", vi.fn().mockResolvedValue([{ id: "chat-existing" }, { id: "chat-later" }]));
    const existing = await renderEffects((state) => { state.seededRef.current = false; });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(existing.state.setChats).toHaveBeenCalledWith([{ id: "chat-existing" }, { id: "chat-later" }]);
    expect(existing.state.setActiveChatId).toHaveBeenCalledWith("chat-existing");
    expect(fakes.methods.get("createChat")).toHaveBeenCalledTimes(1);
    await act(async () => existing.root.unmount());
  });

  it("merges fabricated workflow node events into the matching job status", async () => {
    let statuses: Record<string, Record<string, unknown>> = {};
    const view = await renderEffects((state) => {
      state.setWfNodeStatus = vi.fn((update: (current: typeof statuses) => typeof statuses) => {
        statuses = update(statuses);
      });
    });
    const workflowNode = callback("onWorkflowNode");

    await act(async () => {
      workflowNode({ jobId: "job-1", nodeId: "extract", state: "running" });
      workflowNode({ jobId: "job-1", nodeId: "summarize", state: "done" });
    });

    expect(statuses).toEqual({
      "job-1": {
        extract: { jobId: "job-1", nodeId: "extract", state: "running" },
        summarize: { jobId: "job-1", nodeId: "summarize", state: "done" },
      },
    });
    await act(async () => view.root.unmount());
  });

  it("shows the fabricated sync warning only while the dismissal setting is absent", async () => {
    fakes.methods.set("getSetting", vi.fn(() => Promise.resolve("0")));
    const pending = await renderEffects(undefined, true);
    await act(async () => { await Promise.resolve(); });
    expect(pending.state.setShowSyncWarn).toHaveBeenCalledWith(true);
    await act(async () => pending.root.unmount());

    fakes.methods.set("getSetting", vi.fn(() => Promise.resolve("1")));
    const dismissed = await renderEffects(undefined, true);
    await act(async () => { await Promise.resolve(); });
    expect(dismissed.state.setShowSyncWarn).not.toHaveBeenCalled();
    await act(async () => dismissed.root.unmount());
  });

  it("numbers fabricated organization records from the newest existing entry", async () => {
    let organized: Array<{ name: string; seq: number }> = [];
    const view = await renderEffects((state) => {
      state.setOrganized = vi.fn((update: (current: typeof organized) => typeof organized) => {
        organized = update(organized);
      });
    });
    const organize = callback("onAssistantOrganized");

    await act(async () => {
      organize({ name: "first fabricated change" });
      organize({ name: "second fabricated change" });
    });

    expect(organized).toEqual([
      { name: "second fabricated change", seq: 2 },
      { name: "first fabricated change", seq: 1 },
    ]);
    await act(async () => view.root.unmount());
  });

  it("applies fabricated recording-state transitions and removes the listener on cleanup", async () => {
    const unlistenRecState = vi.fn();
    fakes.methods.set("onRecState", vi.fn((listener: (...args: any[]) => void) => {
      fakes.listeners.set("onRecState", listener);
      return Promise.resolve(unlistenRecState);
    }));
    const view = await renderEffects();
    fakes.stopMicTap.mockClear();
    fakes.applyRecState
      .mockReturnValueOnce({
        live: { fileId: "recording-1", status: "saved" },
        stopTap: true,
        clearSave: true,
        reload: true,
      })
      .mockReturnValueOnce({ live: null, stopTap: false, clearSave: false, reload: false });
    const saved = { fileId: "recording-1", status: "saved" };

    await act(async () => callback("onRecState")(saved));
    expect(fakes.applyRecState).toHaveBeenCalledWith(saved, "file-1");
    expect(view.state.setRecLive).toHaveBeenCalledWith({ fileId: "recording-1", status: "saved" });
    expect(fakes.stopMicTap).toHaveBeenCalledOnce();
    expect(view.state.setRecSave).toHaveBeenCalledWith(null);
    expect(view.actions.viewFile).toHaveBeenCalledWith("recording-1");

    await act(async () => callback("onRecState")({ fileId: "recording-1", status: "failed" }));
    expect(view.state.setRecLive).toHaveBeenLastCalledWith(null);
    expect(fakes.stopMicTap).toHaveBeenCalledOnce();

    await act(async () => view.root.unmount());
    await Promise.resolve();
    expect(unlistenRecState).toHaveBeenCalledOnce();
    expect(fakes.stopMicTap).toHaveBeenCalledTimes(2);
  });

  it("restores fabricated live recording state and deduplicates parked recovery errors", async () => {
    fakes.methods.set("recLiveStatus", vi.fn().mockResolvedValue({
      fileId: "recording-1",
      sessionUrl: "wss://fabricated-recording",
      status: "recording",
    }));
    fakes.methods.set("takeRecRecoveryError", vi.fn().mockResolvedValue("Fabricated parked recovery failure"));
    const view = await renderEffects();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(fakes.startRecordingTransport).toHaveBeenCalledWith(
      "wss://fabricated-recording",
      "recording-1",
    );
    expect(view.state.setRecLive).toHaveBeenCalledWith({ fileId: "recording-1", status: "recording" });
    expect(view.state.pushToast).toHaveBeenCalledWith("error", "Fabricated parked recovery failure");

    view.state.pushToast.mockClear();
    await act(async () => {
      callback("onRecError")({ message: "Fabricated parked recovery failure" });
      callback("onRecError")({ message: "Fabricated parked recovery failure" });
      callback("onRecError")({ fileId: "recording-1", message: "Fabricated recording write failure" });
    });
    expect(view.state.pushToast).toHaveBeenCalledTimes(1);
    expect(view.state.pushToast).toHaveBeenCalledWith("error", "Fabricated recording write failure");
    await act(async () => view.root.unmount());
  });

  it("keeps fabricated turn, recording-save, and transcript progress scoped to workspace state", async () => {
    let recordingSave: { stage: string; remaining: number; startedAt: string } | null = {
      stage: "writing",
      remaining: 4,
      startedAt: "2026-01-02T03:04:05.000Z",
    };
    let sttStatus: Record<string, string> = {};
    let ocrFiles = ["already-scanning.png"];
    const view = await renderEffects((state) => {
      state.setRecSave = vi.fn((update: (current: typeof recordingSave) => typeof recordingSave) => {
        recordingSave = update(recordingSave);
      });
      state.setSttStatus = vi.fn((update: (current: typeof sttStatus) => typeof sttStatus) => {
        sttStatus = update(sttStatus);
      });
      state.setOcrFiles = vi.fn((update: (current: typeof ocrFiles) => typeof ocrFiles) => {
        ocrFiles = update(ocrFiles);
      });
    });
    const turn = { chatId: "chat-1", runId: "run-1" };

    vi.mocked(voice.turnBelongsTo).mockReturnValue(true);
    await act(async () => {
      callback("onAskDelta")("fabricated delta", turn);
      callback("onAskDelta")("ignored delta", { chatId: null, runId: "run-1" });
      callback("onAskRound")(turn);
      callback("onAskRound")({ chatId: null, runId: "run-1" });
      callback("onRecSaveProgress")({ stage: "finishing", remaining: 1 });
      callback("onSttProgress")(["audio.wav", "started"]);
      callback("onSttProgress")(["audio.wav", "done"]);
      callback("onOcrProgress")(["already-scanning.png", "started"]);
      callback("onOcrProgress")(["new-scan.png", "started"]);
      callback("onOcrProgress")(["new-scan.png", "done"]);
      await Promise.resolve();
    });

    expect(view.store.updatedRun).toMatchObject({ text: "" });
    expect(voice.feedStreamDelta).toHaveBeenCalledWith("fabricated delta");
    expect(voice.roundBoundary).toHaveBeenCalledOnce();
    expect(recordingSave).toEqual({
      stage: "finishing",
      remaining: 1,
      startedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(sttStatus).toEqual({ "audio.wav": "done" });
    expect(ocrFiles).toEqual(["already-scanning.png"]);
    expect(fakes.methods.get("listFiles")).toHaveBeenCalledTimes(2);
    await act(async () => view.root.unmount());
  });

  it("keeps fabricated stale search responses out while showing current errors and results", async () => {
    let resolveStale: (value: unknown) => void;
    const stale = new Promise((resolve) => { resolveStale = resolve; });
    let rejectCurrent: (reason: unknown) => void;
    const failed = new Promise<unknown>((_resolve, reject) => { rejectCurrent = reject; });
    let resolveCurrent: (value: unknown) => void;
    const fresh = new Promise((resolve) => { resolveCurrent = resolve; });
    let rejectStale: (reason: unknown) => void;
    const staleFailure = new Promise<unknown>((_resolve, reject) => { rejectStale = reject; });
    fakes.methods.set("searchAll", vi.fn()
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(failed)
      .mockReturnValueOnce(fresh)
      .mockReturnValueOnce(staleFailure));
    const view = await renderEffects((state) => {
      state.showSearch = true;
      state.searchQuery = "first";
    });
    const firstTimer = view.timers.find((timer) => timer.delay === 200);
    if (!firstTimer) throw new Error("first fake search timer missing");
    await act(async () => {
      firstTimer.callback();
      await Promise.resolve();
    });

    view.state.searchQuery = "second";
    await view.render();
    const secondTimer = view.timers.filter((timer) => timer.delay === 200).at(-1);
    if (!secondTimer) throw new Error("second fake search timer missing");
    await act(async () => {
      secondTimer.callback();
      await Promise.resolve();
    });
    await act(async () => {
      resolveStale!({ files: ["stale"] });
      await Promise.resolve();
    });
    expect(view.state.setSearchResults).not.toHaveBeenCalled();

    await act(async () => {
      rejectCurrent!(new Error("fabricated search failure"));
      await Promise.resolve();
    });
    expect(view.state.setSearchResults).toHaveBeenCalledWith(null);
    expect(view.state.setSearchError).toHaveBeenCalledWith("Error: fabricated search failure");
    expect(view.state.setSearchSel).toHaveBeenCalledWith(0);

    view.state.setSearchResults.mockClear();
    view.state.setSearchError.mockClear();
    view.state.setSearchSel.mockClear();
    view.state.searchQuery = "third";
    await view.render();
    const thirdTimer = view.timers.filter((timer) => timer.delay === 200).at(-1);
    if (!thirdTimer) throw new Error("third fake search timer missing");
    await act(async () => {
      thirdTimer.callback();
      await Promise.resolve();
      resolveCurrent!({ files: ["fresh"] });
      await Promise.resolve();
    });
    expect(view.state.setSearchResults).toHaveBeenCalledWith({ files: ["fresh"] });
    expect(view.state.setSearchError).toHaveBeenCalledWith("");
    expect(view.state.setSearchSel).toHaveBeenCalledWith(0);

    view.state.setSearchResults.mockClear();
    view.state.setSearchError.mockClear();
    view.state.setSearchSel.mockClear();
    view.state.searchQuery = "fourth";
    await view.render();
    const fourthTimer = view.timers.filter((timer) => timer.delay === 200).at(-1);
    if (!fourthTimer) throw new Error("fourth fake search timer missing");
    await act(async () => {
      fourthTimer.callback();
      await Promise.resolve();
    });
    view.state.showSearch = false;
    await view.render();
    await act(async () => {
      rejectStale!(new Error("fabricated stale search failure"));
      await Promise.resolve();
    });
    expect(view.state.setSearchResults).not.toHaveBeenCalled();
    expect(view.state.setSearchError).not.toHaveBeenCalled();
    expect(view.state.setSearchSel).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });

  it("clears fabricated blank search input without scheduling a request", async () => {
    const view = await renderEffects((state) => {
      state.showSearch = true;
      state.searchQuery = "   ";
    });

    expect(view.state.setSearchResults).toHaveBeenCalledWith(null);
    expect(view.state.setSearchError).toHaveBeenCalledWith("");
    expect(view.timers.some((timer) => timer.delay === 200)).toBe(false);
    expect(fakes.methods.get("searchAll")).toBeUndefined();
    await act(async () => view.root.unmount());
  });

  it("files fabricated owned agent steps by node and ignores unowned steps", async () => {
    const view = await renderEffects();
    const step = callback("onAskStep");
    view.state.applyToRun.mockClear();

    await act(async () => {
      step({ label: "Read notes", node: "worker" }, { chatId: "chat-1", runId: "run-1" });
    });
    expect(view.store.updatedRun).toMatchObject({
      steps: [{ label: "global", ok: true }, { label: "Read notes", ok: true }],
      agentSteps: {
        worker: [{ label: "worker", ok: true }, { label: "Read notes", ok: true }],
      },
    });

    await act(async () => {
      step({ label: "Fresh task", node: "new-worker" }, { chatId: "chat-1", runId: "run-1" });
      step({ label: "Flat task", node: null }, { chatId: "chat-1", runId: "run-1" });
      step({ label: "Ignored", node: "worker" }, { chatId: null, runId: "run-1" });
    });
    expect(view.store.updatedRun).toMatchObject({
      steps: [{ label: "global", ok: true }, { label: "Flat task", ok: true }],
      agentSteps: { worker: [{ label: "worker", ok: true }] },
    });
    expect(view.state.applyToRun).toHaveBeenCalledTimes(3);
    await act(async () => view.root.unmount());
  });

  it("accepts only a current podcast lookup, clears a live failure, and suppresses stale cleanup", async () => {
    let resolveFirst: (value: unknown) => void;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    let rejectSecond: (reason: unknown) => void;
    const second = new Promise<unknown>((_resolve, reject) => { rejectSecond = reject; });
    let resolveThird: (value: unknown) => void;
    const third = new Promise((resolve) => { resolveThird = resolve; });
    let rejectFourth: (reason: unknown) => void;
    const fourth = new Promise<unknown>((_resolve, reject) => { rejectFourth = reject; });
    fakes.methods.set("getPodcast", vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
      .mockReturnValueOnce(third)
      .mockReturnValueOnce(fourth));
    const view = await renderEffects((state) => {
      state.openFile = { id: "podcast-1" };
      state.openFileRef.current = { id: "podcast-1" };
    });

    view.state.openFileRef.current = null;
    await act(async () => {
      resolveFirst!({ id: "podcast-1", title: "Fabricated first" });
      await Promise.resolve();
    });
    expect(view.state.setOpenPodcast).not.toHaveBeenCalled();

    view.state.openFile = { id: "podcast-2" };
    view.state.openFileRef.current = { id: "podcast-2" };
    await view.render();
    await act(async () => {
      rejectSecond!(new Error("fabricated podcast lookup failure"));
      await Promise.resolve();
    });
    expect(view.state.setOpenPodcast).toHaveBeenCalledWith(null);

    view.state.openFile = { id: "podcast-3" };
    view.state.openFileRef.current = { id: "podcast-3" };
    await view.render();
    const activePodcast = { id: "podcast-3", title: "Fabricated current" };
    await act(async () => {
      resolveThird!(activePodcast);
      await Promise.resolve();
    });
    expect(view.state.setOpenPodcast).toHaveBeenLastCalledWith(activePodcast);

    view.state.openFile = { id: "podcast-4" };
    view.state.openFileRef.current = { id: "podcast-4" };
    await view.render();
    await act(async () => view.root.unmount());
    await act(async () => {
      rejectFourth!(new Error("fabricated stale lookup failure"));
      await Promise.resolve();
    });
    expect(view.state.setOpenPodcast).toHaveBeenCalledTimes(2);
  });

  it("deduplicates fabricated background recording-source failures until recovery and removes its listener", async () => {
    const unlistenRecSource = vi.fn();
    fakes.methods.set("onRecSource", vi.fn((listener: (...args: any[]) => void) => {
      fakes.listeners.set("onRecSource", listener);
      return Promise.resolve(unlistenRecSource);
    }));
    const view = await renderEffects();
    view.state.pushToast.mockClear();
    const source = callback("onRecSource");

    await act(async () => {
      source({ fileId: "file-2", source: "mic", status: "error", message: "Fake microphone lost" });
      source({ fileId: "file-2", source: "mic", status: "error", message: "Fake microphone lost" });
      source({ fileId: "file-2", source: "mic", status: "recovered", message: "" });
      source({ fileId: "file-2", source: "mic", status: "error", message: "Fake microphone lost again" });
      source({ fileId: "file-1", source: "system", status: "error", message: "Open recording source failed" });
      source({ fileId: "file-1", source: "system", status: "recovered", message: "" });
    });

    expect(view.state.pushToast).toHaveBeenNthCalledWith(1, "error", "Fake microphone lost");
    expect(view.state.pushToast).toHaveBeenNthCalledWith(2, "error", "Fake microphone lost again");
    expect(view.state.pushToast).toHaveBeenCalledTimes(2);

    await act(async () => view.root.unmount());
    await Promise.resolve();
    expect(unlistenRecSource).toHaveBeenCalledTimes(1);
  });

  it("reports fabricated privacy scan terminal states, opens the recovery section, and cleans up", async () => {
    const unlistenScan = vi.fn();
    fakes.methods.set("onPrivacyScan", vi.fn((listener: (...args: any[]) => void) => {
      fakes.listeners.set("onPrivacyScan", listener);
      return Promise.resolve(unlistenScan);
    }));
    const view = await renderEffects();
    view.actions.refreshPrivacy.mockClear();
    view.state.pushToast.mockClear();
    const scan = callback("onPrivacyScan");

    await act(async () => scan({ running: true }));
    expect(view.state.setPrivacyScanning).toHaveBeenLastCalledWith(true);
    expect(view.actions.refreshPrivacy).not.toHaveBeenCalled();

    await act(async () => scan({ running: false }));
    expect(view.state.setPrivacyScanning).toHaveBeenLastCalledWith(false);
    expect(view.actions.refreshPrivacy).toHaveBeenCalledOnce();

    await act(async () => scan({ running: false, error: "fake scanner failure" }));
    expect(view.actions.refreshPrivacy).toHaveBeenCalledTimes(2);
    expect(view.state.pushToast).toHaveBeenCalledWith(
      "error",
      "Couldn't scan for private details — fake scanner failure",
      expect.objectContaining({ label: "Open privacy", run: expect.any(Function) }),
    );
    const recovery = view.state.pushToast.mock.calls.at(-1)?.[2] as { run: () => void };
    recovery.run();
    expect(view.state.setSettingsSection).toHaveBeenCalledWith("set-cloud-privacy");
    expect(view.state.setShowSettings).toHaveBeenCalledWith(true);

    await act(async () => view.root.unmount());
    await Promise.resolve();
    expect(unlistenScan).toHaveBeenCalledOnce();
  });

  it("shows fabricated browser-download success and error receipts, including the fallback, then cleans up", async () => {
    const unlistenDownload = vi.fn();
    fakes.methods.set("onBrowserDownload", vi.fn((listener: (...args: any[]) => void) => {
      fakes.listeners.set("onBrowserDownload", listener);
      return Promise.resolve(unlistenDownload);
    }));
    const view = await renderEffects();
    view.state.pushToast.mockClear();
    const download = callback("onBrowserDownload");

    await act(async () => {
      download({ ok: true, name: "notes.md" });
      download({ ok: false, name: "archive.zip", error: "fake disk full" });
      download({ ok: false, name: "unknown.bin" });
    });
    expect(view.state.pushToast).toHaveBeenNthCalledWith(
      1,
      "success",
      "notes.md arrived in the room.",
    );
    expect(view.state.pushToast).toHaveBeenNthCalledWith(
      2,
      "error",
      "Download of archive.zip failed: fake disk full",
    );
    expect(view.state.pushToast).toHaveBeenNthCalledWith(
      3,
      "error",
      "Download of unknown.bin failed: unknown error",
    );

    await act(async () => view.root.unmount());
    await Promise.resolve();
    expect(unlistenDownload).toHaveBeenCalledOnce();
  });

  it("files owned specialist reports, ignores stale events, and removes the listener", async () => {
    const unlistenReport = vi.fn();
    fakes.methods.set("onAskReport", vi.fn((listener: (...args: any[]) => void) => {
      fakes.listeners.set("onAskReport", listener);
      return Promise.resolve(unlistenReport);
    }));
    const view = await renderEffects();
    const report = callback("onAskReport");
    view.state.applyToRun.mockClear();

    await act(async () => {
      report(
        { node: "file-worker", text: "Found the fabricated lease.", ok: true },
        { chatId: "chat-1", runId: "run-1" },
      );
    });
    expect(view.store.updatedRun).toMatchObject({
      agentReports: { "file-worker": { text: "Found the fabricated lease.", ok: true } },
    });

    await act(async () => {
      report(
        { node: "web-worker", text: "Fabricated lookup failed.", ok: false },
        { chatId: "chat-1", runId: "run-1" },
      );
    });
    expect(view.store.updatedRun).toMatchObject({
      agentReports: { "web-worker": { text: "Fabricated lookup failed.", ok: false } },
    });

    await act(async () => {
      report(
        { node: "stale-worker", text: "must be ignored", ok: true },
        { chatId: null, runId: "run-1" },
      );
      report(
        { node: "", text: "missing node", ok: true },
        { chatId: "chat-1", runId: "run-1" },
      );
    });
    expect(view.state.applyToRun).toHaveBeenCalledTimes(2);

    await act(async () => view.root.unmount());
    await Promise.resolve();
    expect(unlistenReport).toHaveBeenCalledOnce();
  });

  it("keeps step failure, consent, harness, file refresh, and model-change callbacks scoped", async () => {
    const view = await renderEffects();

    await act(async () => {
      callback("onAskStepStatus")({ ok: false, node: "worker" }, { chatId: "chat-1", runId: "run-1" });
      callback("onAskStepStatus")({ ok: true, node: "worker" }, { chatId: "chat-1", runId: "run-1" });
      view.state.applyToRun.mockImplementationOnce((_chat: string, _runId: string, update: (run: Record<string, unknown>) => unknown) =>
        update({ steps: [], agentSteps: {} }),
      );
      callback("onAskStepStatus")({ ok: false }, { chatId: "chat-1", runId: "run-1" });
      view.state.applyToRun.mockImplementationOnce((_chat: string, _runId: string, update: (run: Record<string, unknown>) => unknown) =>
        update({ steps: [{ label: "global", ok: true }], agentSteps: {} }),
      );
      callback("onAskStepStatus")({ ok: false, node: "missing" }, { chatId: "chat-1", runId: "run-1" });
      await callback("onAgentUiRequest")({
        id: "consent-1",
        kind: "browse_consent",
        args: { url: "https://example.test", field: "Email", text: "person@example.test", entities: ["email"] },
      });
      await callback("onAgentUiRequest")({ id: "consent-defaults", kind: "browse_consent", args: {} });
      fakes.handleAgentUiRequest.mockResolvedValueOnce({ ok: true });
      await callback("onAgentUiRequest")({ id: "snapshot-1", kind: "ui_snapshot", args: {} });
      fakes.handleAgentUiRequest.mockRejectedValueOnce(new Error("fake driver failure"));
      await callback("onAgentUiRequest")({ id: "snapshot-error", kind: "ui_act", args: {} });
      callback("onHarnessEvent")({ type: "approval_requested", id: "approval-1" });
      callback("onHarnessEvent")({ type: "run_failed", error: "fake failure", id: "run-1" });
      await callback("onFileUpdated")("file-1");
      await Promise.resolve();
    });

    expect(view.store.updatedRun).toMatchObject({
      steps: [{ label: "global", ok: false }],
      agentSteps: { worker: [{ label: "worker", ok: false }] },
    });
    expect(view.store.browseConsents).toEqual([{
      id: "consent-1",
      url: "https://example.test",
      field: "Email",
      text: "person@example.test",
      entities: ["email"],
    }, {
      id: "consent-defaults",
      url: "",
      field: "a field",
      text: "",
      entities: [],
    }]);
    expect(fakes.handleAgentUiRequest).toHaveBeenCalledWith({
      id: "snapshot-1",
      kind: "ui_snapshot",
      args: {},
    });
    const resolved = fakes.methods.get("resolveAgentUi");
    expect(resolved).toHaveBeenCalledWith("snapshot-error", {
      error: "Error: fake driver failure",
    });
    expect(view.state.setAiTab).toHaveBeenCalledWith("activity");
    expect(view.state.pushToast).toHaveBeenCalledWith("error", "Agent run failed: fake failure");
    expect(view.state.editedRef.current.has("file-1")).toBe(true);
    expect(view.state.setOpenFile).toHaveBeenCalledWith({
      id: "file-1",
      content: null,
    });
    expect(view.state.setViewerRev).toHaveBeenCalledWith(expect.any(Function));
    expect(view.state.pushToast).toHaveBeenCalledWith("info", "Switched to Engine new-model");

    view.state.editModeRef.current = true;
    view.state.editorDirtyRef.current = true;
    await act(async () => callback("onFileUpdated")("file-1"));
    expect(view.state.setStaleFile).toHaveBeenCalledWith("file-1");
    await act(async () => view.root.unmount());
  });

  it("re-arms hands-free dictation only after the turn closes and only while the mic is idle", async () => {
    const view = await renderEffects();
    const audioDone = callback("voiceAudioDone");

    audioDone();
    expect(view.actions.dictateTo).not.toHaveBeenCalled();

    view.state.handsFreeRef.current = true;
    view.state.askingRef.current = true;
    audioDone();
    audioDone();
    expect(view.timers).toHaveLength(1);
    expect(view.timers[0]).toMatchObject({ delay: 150 });
    expect(view.state.armTimerRef.current).toBe(1);

    view.state.askingRef.current = false;
    await act(async () => view.timers[0]!.callback());
    expect(view.state.armTimerRef.current).toBeNull();
    expect(view.actions.dictateTo).toHaveBeenCalledWith("composer", expect.any(Function));
    const sendDictation = view.actions.dictateTo.mock.calls[0]?.[1] as (text: string) => void;
    sendDictation("fake dictated text");
    expect(view.actions.send).toHaveBeenCalledWith("fake dictated text");

    view.state.dictStateRef.current = "recording";
    audioDone();
    expect(view.actions.dictateTo).toHaveBeenCalledTimes(1);
    await act(async () => view.root.unmount());
  });

  it("files fabricated live agent lane, plan, privacy, token, and import updates only for the owned turn", async () => {
    const view = await renderEffects();
    const updates: Record<string, unknown>[] = [];
    view.state.applyToRun.mockImplementation(
      (_chat: string, _runId: string, update: (run: Record<string, unknown>) => Record<string, unknown>) => {
        updates.push(update({ text: "", steps: [], agentSteps: {} }));
      },
    );
    const turn = { chatId: "chat-1", runId: "run-1" };
    const privacy = { masked: 2, bypassed: false };
    const usage = { inputTokens: 8, outputTokens: 3 };

    await act(async () => {
      callback("onAskLane")("fabricated lane", turn);
      callback("onAskPlan")({ specialists: ["fabricated worker"] }, turn);
      callback("onAskAgent")("fabricated worker", turn);
      callback("onAskPrivacy")(privacy, turn);
      callback("onAskTokenUsage")(usage, turn);
      callback("onImportProgress")({ done: 1, total: 2, name: "fake import" });
      callback("onImportProgress")({ done: 2, total: 2, name: "fake import" });
      callback("onAskLane")("ignored", { chatId: null, runId: "run-1" });
    });

    expect(updates).toEqual([
      { text: "", steps: [], agentSteps: {}, lane: "fabricated lane" },
      { text: "", steps: [], agentSteps: {}, plan: { specialists: ["fabricated worker"] } },
      { text: "", steps: [], agentSteps: {}, agent: "fabricated worker" },
    ]);
    expect(view.state.setAskPrivacy).toHaveBeenCalledWith("chat-1", privacy);
    expect(view.state.setChatUsage).toHaveBeenCalledWith("chat-1", usage);
    expect(view.state.setImportProgress).toHaveBeenNthCalledWith(1, { done: 1, total: 2, name: "fake import" });
    expect(view.state.setImportProgress).toHaveBeenNthCalledWith(2, null);
    await act(async () => view.root.unmount());
  });

  it("routes fabricated background status, approval, pull, and drag events into workspace-only state", async () => {
    let scriptApprovals: unknown[] = [];
    let mcpApprovals: unknown[] = [];
    let editApprovals: unknown[] = [];
    let jobProgress: Record<string, unknown> = {};
    fakes.methods.set("listMemories", vi.fn().mockResolvedValue([{ id: "memory-1" }]));
    const view = await renderEffects((state) => {
      state.setScriptApprovals = vi.fn((update: (items: unknown[]) => unknown[]) => {
        scriptApprovals = update(scriptApprovals);
      });
      state.setMcpApprovals = vi.fn((update: (items: unknown[]) => unknown[]) => {
        mcpApprovals = update(mcpApprovals);
      });
      state.setEditApprovals = vi.fn((update: (items: unknown[]) => unknown[]) => {
        editApprovals = update(editApprovals);
      });
      state.setJobProgress = vi.fn((update: (jobs: typeof jobProgress) => typeof jobProgress) => {
        jobProgress = update(jobProgress);
      });
    });

    await act(async () => {
      callback("onStudioStep")({ step: "Fabricated export", local: false });
      callback("onJobProgress")({ jobId: "background-1", label: "Fabricated job", done: 1, total: 4 });
      callback("onWorkflowsChanged")();
      callback("onScriptApproveRequest")({ id: "script-approval" });
      callback("onSkillsChanged")();
      callback("onMemoriesChanged")();
      callback("listen:pull-progress")({ payload: { status: "fake pulling", percent: 75 } });
      await callback("onDragDropEvent")({ payload: { type: "enter", paths: [] } });
      callback("onBrowserNavigated")();
      callback("onBrowserDownloadOversize")({ detail: "fake download is too large" });
      callback("onMcpApproveRequest")({ id: "mcp-approval" });
      callback("onEditApproveRequest")({ id: "edit-approval" });
      await Promise.resolve();
    });

    expect(view.state.setStudioStep).toHaveBeenCalledWith({ text: "Fabricated export", local: false });
    expect(jobProgress).toEqual({ "background-1": { label: "Fabricated job", done: 1, total: 4 } });
    expect(view.actions.refreshWorkflows).toHaveBeenCalled();
    expect(view.actions.refreshScripts).toHaveBeenCalled();
    expect(view.actions.refreshSkills).toHaveBeenCalled();
    expect(view.state.setMemories).toHaveBeenCalledWith([{ id: "memory-1" }]);
    expect(view.state.setPullStatus).toHaveBeenCalledWith("fake pulling");
    expect(view.state.setPullPercent).toHaveBeenCalledWith(75);
    expect(view.state.setDragOver).toHaveBeenCalledWith(true);
    expect(view.actions.revealBrowser).toHaveBeenCalledOnce();
    expect(view.state.pushToast).toHaveBeenCalledWith("error", "fake download is too large");
    expect(scriptApprovals).toEqual([{ id: "script-approval" }]);
    expect(mcpApprovals).toEqual([{ id: "mcp-approval" }]);
    expect(editApprovals).toEqual([{ id: "edit-approval" }]);
    await act(async () => view.root.unmount());
  });

  it("refreshes fabricated room and MCP status data, including a parked privacy-scan error action", async () => {
    fakes.methods.set("listFiles", vi.fn().mockResolvedValue([{ id: "file-from-event" }]));
    fakes.methods.set("listFolders", vi.fn().mockResolvedValue([{ id: "folder-from-event" }]));
    fakes.methods.set("listTrashedFiles", vi.fn().mockResolvedValue([{ id: "trash-from-event" }]));
    fakes.methods.set("mcpStatus", vi.fn().mockResolvedValue([{ name: "fake-mcp" }]));
    fakes.methods.set("privacyStatus", vi.fn().mockResolvedValue({ lastScanError: "fabricated parked scan failure" }));
    const view = await renderEffects();
    view.state.setFiles.mockClear();
    view.state.setFolders.mockClear();
    view.state.setTrashed.mockClear();

    await act(async () => {
      callback("onRoomFilesChanged")();
      callback("onMcpStatus")([{ name: "updated-fake-mcp" }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.state.setFiles).toHaveBeenCalledWith([{ id: "file-from-event" }]);
    expect(view.state.setFolders).toHaveBeenCalledWith([{ id: "folder-from-event" }]);
    expect(view.state.setTrashed).toHaveBeenCalledWith([{ id: "trash-from-event" }]);
    expect(view.actions.loadFrontPage).toHaveBeenCalledWith(false);
    expect(view.actions.refreshScripts).toHaveBeenCalled();
    expect(view.actions.refreshPrivacy).toHaveBeenCalled();
    expect(view.state.setMcpStatuses).toHaveBeenLastCalledWith([{ name: "updated-fake-mcp" }]);
    expect(view.actions.connectedTools).toHaveBeenLastCalledWith([{ name: "updated-fake-mcp" }]);
    expect(view.state.pushToast).toHaveBeenCalledWith(
      "error",
      "Couldn't scan for private details — fabricated parked scan failure",
      expect.objectContaining({ label: "Open privacy", run: expect.any(Function) }),
    );
    const parkedError = view.state.pushToast.mock.calls.at(-1)?.[2] as { run: () => void };
    parkedError.run();
    expect(view.state.setSettingsSection).toHaveBeenCalledWith("set-cloud-privacy");
    expect(view.state.setShowSettings).toHaveBeenCalledWith(true);
    await act(async () => view.root.unmount());
  });
});
