import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import * as voice from "./voice";
import {
  useWorkspaceKeyboardShortcuts,
  workspaceEffectsTestables,
} from "./effects";

const { act, createElement } = React;

const globalKeys = [
  "document",
  "window",
  "Node",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function keyboardState() {
  return {
    ctxMenuRef: { current: false },
    showSearchRef: { current: false },
    showSettingsRef: { current: false },
    showMapRef: { current: false },
    showWorkflowsRef: { current: false },
    showScriptsRef: { current: false },
    openFileRef: { current: null as { id: string } | null },
    setCtxMenu: vi.fn(),
    setShowSearch: vi.fn(),
    setShowMap: vi.fn(),
    setShowWorkflows: vi.fn(),
    setShowScripts: vi.fn(),
    setSearchSel: vi.fn(),
    setShowSettings: vi.fn(),
    setOpenMenu: vi.fn(),
    setShowShortcuts: vi.fn(),
    setOpenFile: vi.fn(),
  };
}

function keyboardActions() {
  return {
    newChat: vi.fn(),
    handleLock: vi.fn(),
    guardLeave: vi.fn(),
  };
}

function eventState() {
  return {
    askingRef: { current: false },
    internalDragRef: { current: false },
    lastActivityRef: { current: 0 },
    autolockRef: { current: "off" },
    recLiveRef: { current: null as { fileId: string } | null },
    openFileRef: { current: null as { id: string; target?: unknown } | null },
    pushToast: vi.fn(),
    setAutoSpeak: vi.fn(),
    setFiles: vi.fn(),
    setHandsFree: vi.fn(),
    setImportProgress: vi.fn(),
    setJobProgress: vi.fn(
      (update: (jobs: Record<string, unknown>) => unknown) =>
        update({ active: { done: 2 } }),
    ),
    setDragOver: vi.fn(),
    setStudioStep: vi.fn(),
  };
}

function eventActions() {
  return {
    refreshJobs: vi.fn(),
    reportImport: vi.fn(),
    viewFile: vi.fn(),
  };
}

type KeyboardState = ReturnType<typeof keyboardState>;
type KeyboardActions = ReturnType<typeof keyboardActions>;

function ShortcutProbe({
  state,
  actions,
  eventTarget,
}: {
  state: KeyboardState;
  actions: KeyboardActions;
  eventTarget: Pick<Window, "addEventListener" | "removeEventListener">;
}) {
  useWorkspaceKeyboardShortcuts(state as never, actions as never, eventTarget);
  return null;
}

async function renderProbe() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "Node", window.Node);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "HTMLTextAreaElement", window.HTMLTextAreaElement);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const add = vi.fn();
  const remove = vi.fn();
  const eventTarget = { addEventListener: add, removeEventListener: remove };
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const state = keyboardState();
  const actions = keyboardActions();
  await act(async () => {
    root.render(createElement(ShortcutProbe, { state, actions, eventTarget }));
    await Promise.resolve();
  });
  const listener = add.mock.calls.find(([type]) => type === "keydown")?.[1];
  if (typeof listener !== "function")
    throw new Error("keydown listener missing");
  return { actions, document, listener, remove, root, state, window };
}

function keyEvent(
  key: string,
  overrides: Partial<KeyboardEvent> = {},
): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    target: null,
    preventDefault: vi.fn(),
    ...overrides,
  } as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("workspace keyboard shortcuts", () => {
  it("closes Escape targets in priority order and preserves typing and Monaco rules", async () => {
    const view = await renderProbe();
    const fire = (event: KeyboardEvent) => view.listener(event);

    view.state.ctxMenuRef.current = true;
    view.state.showSearchRef.current = true;
    const menu = keyEvent("Escape");
    fire(menu);
    expect(menu.preventDefault).toHaveBeenCalledOnce();
    expect(view.state.setCtxMenu).toHaveBeenCalledWith(null);
    expect(view.state.setShowSearch).not.toHaveBeenCalled();

    view.state.ctxMenuRef.current = false;
    const search = keyEvent("Escape");
    fire(search);
    expect(view.state.setShowSearch).toHaveBeenCalledWith(false);

    view.state.showSearchRef.current = false;
    view.state.showSettingsRef.current = true;
    const settings = keyEvent("Escape");
    fire(settings);
    expect(settings.preventDefault).not.toHaveBeenCalled();
    expect(view.state.setShowMap).not.toHaveBeenCalled();

    view.state.showSettingsRef.current = false;
    view.state.showMapRef.current = true;
    fire(keyEvent("Escape"));
    expect(view.state.setShowMap).toHaveBeenCalledWith(false);
    view.state.showMapRef.current = false;
    view.state.showWorkflowsRef.current = true;
    fire(keyEvent("Escape"));
    expect(view.state.setShowWorkflows).toHaveBeenCalledWith(false);
    view.state.showWorkflowsRef.current = false;
    view.state.showScriptsRef.current = true;
    fire(keyEvent("Escape"));
    expect(view.state.setShowScripts).toHaveBeenCalledWith(false);

    view.state.showScriptsRef.current = false;
    view.state.openFileRef.current = { id: "file-1" };
    const input = view.document.createElement("input");
    fire(keyEvent("Escape", { target: input }));
    expect(view.actions.guardLeave).not.toHaveBeenCalled();
    const monaco = view.document.createElement("div");
    monaco.className = "monaco-editor";
    const textarea = view.document.createElement("textarea");
    monaco.append(textarea);
    const file = keyEvent("Escape", { target: textarea });
    fire(file);
    expect(file.preventDefault).toHaveBeenCalledOnce();
    expect(view.actions.guardLeave).toHaveBeenCalledWith(
      "Closing this file",
      expect.any(Function),
    );
    const close = view.actions.guardLeave.mock.calls.at(-1)?.[1] as () => void;
    close();
    expect(view.state.setOpenFile).toHaveBeenCalledWith(null);
    await act(async () => view.root.unmount());
  });

  it("dispatches meta shortcuts and lets a viewer keep a prevented Command-F", async () => {
    const view = await renderProbe();
    const fire = (event: KeyboardEvent) => view.listener(event);
    fire(keyEvent("n", { metaKey: true }));
    fire(keyEvent("l", { metaKey: true }));
    expect(view.actions.newChat).toHaveBeenCalledOnce();
    expect(view.actions.handleLock).toHaveBeenCalledOnce();

    const viewerFind = keyEvent("f", { metaKey: true, defaultPrevented: true });
    fire(viewerFind);
    expect(viewerFind.preventDefault).not.toHaveBeenCalled();
    expect(view.state.setShowSearch).not.toHaveBeenCalled();

    const roomFind = keyEvent("f", { metaKey: true });
    fire(roomFind);
    expect(roomFind.preventDefault).toHaveBeenCalledOnce();
    expect(view.state.setSearchSel).toHaveBeenCalledWith(0);
    expect(view.state.setShowSearch).toHaveBeenCalledWith(true);
    fire(keyEvent("k", { metaKey: true }));
    fire(keyEvent(",", { metaKey: true }));
    expect(view.state.setShowSettings).toHaveBeenCalledWith(true);
    fire(keyEvent("j", { metaKey: true }));
    const toggleMenu = view.state.setOpenMenu.mock.calls.at(-1)?.[0] as (
      value: "workflows" | null,
    ) => "workflows" | null;
    expect(toggleMenu(null)).toBe("workflows");
    expect(toggleMenu("workflows")).toBeNull();
    fire(keyEvent("/", { metaKey: true }));
    const toggleShortcuts = view.state.setShowShortcuts.mock.calls.at(
      -1,
    )?.[0] as (value: boolean) => boolean;
    expect(toggleShortcuts(false)).toBe(true);
    await act(async () => view.root.unmount());
  });

  it("removes the exact window listener on unmount", async () => {
    const view = await renderProbe();
    await act(async () => view.root.unmount());
    expect(view.remove).toHaveBeenCalledWith("keydown", view.listener);
  });
});

describe("workspace effect event handlers", () => {
  it("tracks running and terminal jobs without interrupting an active answer", () => {
    const state = eventState();
    const actions = eventActions();
    const seen = new Set<string>();
    const handle = workspaceEffectsTestables.handleJobProgress;

    handle(state as never, actions as never, seen, {
      jobId: "new-job",
      label: "Indexing",
      done: 1,
      total: 2,
    });
    handle(state as never, actions as never, seen, {
      jobId: "new-job",
      label: "Indexing",
      done: 2,
      total: 2,
    });
    expect(actions.refreshJobs).toHaveBeenCalledOnce();
    expect(state.setJobProgress).toHaveBeenCalledTimes(2);

    handle(state as never, actions as never, seen, {
      jobId: "new-job",
      label: "Summary ready",
      done: 2,
      total: 2,
      finished: true,
      fileId: "summary",
    });
    expect(state.setStudioStep).toHaveBeenCalledWith({ text: "", local: true });
    expect(actions.viewFile).toHaveBeenCalledWith("summary");

    state.askingRef.current = true;
    handle(state as never, actions as never, seen, {
      jobId: "waiting-job",
      label: "Report ready",
      done: 1,
      total: 1,
      finished: true,
      fileId: "report",
    });
    const deferredOpen = state.pushToast.mock.calls.at(-1)?.[2] as {
      run: () => void;
    };
    deferredOpen.run();
    expect(actions.viewFile).toHaveBeenLastCalledWith("report");

    handle(state as never, actions as never, seen, {
      jobId: "notice-job",
      label: "Ready",
      done: 1,
      total: 1,
      finished: true,
    });
    handle(state as never, actions as never, seen, {
      jobId: "paused-job",
      label: "",
      done: 1,
      total: 2,
      paused: true,
    });
    handle(state as never, actions as never, seen, {
      jobId: "failed-job",
      label: "",
      done: 1,
      total: 2,
      failed: true,
    });
    expect(state.pushToast).toHaveBeenCalledWith(
      "info",
      "Paused — resume it any time from the sidebar.",
    );
    expect(state.pushToast).toHaveBeenLastCalledWith(
      "error",
      "Background job failed.",
    );
  });

  it("handles drag boundaries, imports drops, and reports import failures", async () => {
    const state = eventState();
    const actions = eventActions();
    const handle = workspaceEffectsTestables.handleWorkspaceDrop;
    const importFiles = vi.spyOn(api, "importFiles");
    const listFiles = vi.spyOn(api, "listFiles");

    await handle(state as never, actions as never, {
      type: "enter",
      paths: [],
    });
    await handle(state as never, actions as never, { type: "over", paths: [] });
    await handle(state as never, actions as never, {
      type: "leave",
      paths: [],
    });
    state.internalDragRef.current = true;
    await handle(state as never, actions as never, {
      type: "drop",
      paths: ["ignored"],
    });
    expect(importFiles).not.toHaveBeenCalled();

    state.internalDragRef.current = false;
    await handle(state as never, actions as never, { type: "drop", paths: [] });
    importFiles.mockResolvedValue({} as never);
    listFiles.mockResolvedValue([] as never);
    await handle(state as never, actions as never, {
      type: "drop",
      paths: ["one", "two"],
    });
    expect(state.setImportProgress).toHaveBeenCalledWith({
      done: 0,
      total: 2,
      name: "Starting…",
    });
    expect(actions.reportImport).toHaveBeenCalledOnce();
    expect(state.setFiles).toHaveBeenCalledWith([]);

    importFiles.mockRejectedValueOnce(new Error("disk full"));
    await handle(state as never, actions as never, {
      type: "drop",
      paths: ["one"],
    });
    expect(state.pushToast).toHaveBeenCalledWith("error", "Error: disk full");
    expect(state.setImportProgress).toHaveBeenLastCalledWith(null);
  });

  it("opens agent files only when their navigation target is meaningful", () => {
    const state = eventState();
    const actions = eventActions();
    const handle = workspaceEffectsTestables.handleAgentOpenFile;

    handle(state as never, actions as never, "plain-file");
    handle(state as never, actions as never, { id: "bare-file" });
    state.openFileRef.current = { id: "current-file", target: { page: 2 } };
    handle(state as never, actions as never, { id: "current-file" });
    handle(state as never, actions as never, { id: "book", page: 3 });
    handle(state as never, actions as never, { id: "sheet", cell: "B2" });
    handle(state as never, actions as never, { id: "note", find: "needle" });

    expect(actions.viewFile).toHaveBeenCalledWith("plain-file");
    expect(actions.viewFile).toHaveBeenCalledWith("bare-file");
    expect(actions.viewFile).not.toHaveBeenCalledWith("current-file");
    expect(actions.viewFile).toHaveBeenCalledWith("book", {
      page: 3,
      cell: undefined,
      range: undefined,
      find: undefined,
      quote: undefined,
    });
    expect(actions.viewFile).toHaveBeenCalledWith("sheet", {
      page: undefined,
      cell: "B2",
      range: "B2",
      find: undefined,
      quote: undefined,
    });
    expect(actions.viewFile).toHaveBeenCalledWith("note", {
      page: undefined,
      cell: undefined,
      range: undefined,
      find: "needle",
      quote: "needle",
    });
  });

  it("loads saved voice settings and uses defaults for malformed values", async () => {
    const state = eventState();
    const configure = vi.spyOn(voice, "configure");
    const settings = vi.spyOn(api, "getSetting");
    settings.mockImplementation(async (key) => {
      const values: Record<string, string | null> = {
        voice_archetype: "warm",
        voice_params: '{"rate":1.2}',
        voice_autospeak: "1",
        voice_handsfree: "1",
        voice_neural_id: "voice-id",
      };
      return values[key] ?? null;
    });
    workspaceEffectsTestables.loadSavedVoice(state as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({
        archetype: "warm",
        autoSpeak: true,
        neuralVoiceId: "voice-id",
      }),
    );
    expect(state.setAutoSpeak).toHaveBeenCalledWith(true);
    expect(state.setHandsFree).toHaveBeenCalledWith(true);

    workspaceEffectsTestables.configureSavedVoice(state as never, [
      "off",
      "not json",
      "0",
      "0",
      null,
    ]);
    expect(configure).toHaveBeenLastCalledWith(
      expect.objectContaining({ archetype: "off", autoSpeak: false }),
    );
    settings.mockRejectedValueOnce(new Error("settings unavailable"));
    workspaceEffectsTestables.loadSavedVoice(state as never);
    await Promise.resolve();
    await Promise.resolve();
  });

  it("keeps autolock aware of active work and reports a failed lock", async () => {
    const state = eventState();
    const cancelAll = vi.spyOn(voice, "cancelAll");
    const isSpeaking = vi.spyOn(voice, "isSpeaking").mockReturnValue(false);
    vi.spyOn(Date, "now").mockReturnValue(120_000);
    const tick = workspaceEffectsTestables.runAutoLockTick;
    const lock = vi.fn();

    expect(tick(state as never, lock, 0)).toBe(120_000);
    state.autolockRef.current = "nonsense";
    expect(tick(state as never, lock, 0)).toBe(120_000);
    state.autolockRef.current = "1";
    state.askingRef.current = true;
    tick(state as never, lock, 0);
    expect(lock).not.toHaveBeenCalled();
    state.askingRef.current = false;
    state.recLiveRef.current = { fileId: "rec" };
    tick(state as never, lock, 0);
    expect(state.lastActivityRef.current).toBe(120_000);
    state.recLiveRef.current = null;
    isSpeaking.mockReturnValue(true);
    tick(state as never, lock, 0);
    isSpeaking.mockReturnValue(false);

    state.lastActivityRef.current = 0;
    const failedLock = vi.fn(() => Promise.reject(new Error("locked out")));
    tick(state as never, failedLock, 0);
    await Promise.resolve();
    expect(cancelAll).toHaveBeenCalledOnce();
    expect(state.pushToast).toHaveBeenCalledWith(
      "error",
      "Auto-lock failed — this room is still open.",
    );
  });
});
