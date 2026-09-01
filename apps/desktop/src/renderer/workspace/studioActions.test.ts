import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiActionDef } from "../api";
import type { WSState } from "./state";

const mocks = vi.hoisted(() => ({
  api: {
    aiAction: vi.fn(),
    aiActionPrompts: vi.fn(),
    cancelJob: vi.fn(),
    cancelAsk: vi.fn(),
    deleteJob: vi.fn(),
    listFiles: vi.fn(),
    listJobs: vi.fn(),
    resumeJob: vi.fn(),
    startDeepSummary: vi.fn(),
    startStudioJob: vi.fn(),
  },
  resolveRefs: vi.fn(),
  studioPrompts: vi.fn(),
}));

vi.mock("../api", () => ({
  api: mocks.api,
  studioPrompts: mocks.studioPrompts,
}));
vi.mock("./composer", () => ({
  isOllamaDown: () => false,
  resolveRefs: mocks.resolveRefs,
}));

import { makeStudioActions } from "./studioActions";

type MutableState = Record<string, any>;

function actionDef(overrides: Partial<AiActionDef> = {}): AiActionDef {
  return {
    id: "summarize",
    title: "Summarize",
    description: "Summarize the room",
    scope: "room",
    needsQuestion: false,
    needsLanguage: false,
    defaultPrompt: "Summarize this",
    ...overrides,
  };
}

function actionPrompt(overrides: Record<string, unknown> = {}) {
  return {
    def: actionDef(),
    scope: "room-1",
    refs: ["saved", "mentioned"],
    text: "Keep the requested tone for @notes.md",
    question: "",
    ...overrides,
  };
}

function state(overrides: MutableState = {}): MutableState {
  const value: MutableState = {
    aiBusy: false,
    aiActionDefs: null,
    aiOpId: null,
    aiPrompt: actionPrompt(),
    aiStopping: false,
    studioAc: null,
    studioDefaults: null,
    studioPrompt: null,
    studioPromptRef: { current: null },
    jobs: [],
    summaryStarting: false,
    events: [] as string[],
    files: [],
    folders: [],
    pushToast: vi.fn(),
    ...overrides,
  };
  const setter = (method: string, property: string, event: string) => {
    value[method] = vi.fn((next: unknown) => {
      value[property] = typeof next === "function" ? next(value[property]) : next;
      value.events.push(`${event}:${String(value[property])}`);
    });
  };
  setter("setAiBusy", "aiBusy", "busy");
  setter("setAiActionDefs", "aiActionDefs", "aiActionDefs");
  setter("setAiOpId", "aiOpId", "op");
  setter("setAiPrompt", "aiPrompt", "prompt");
  setter("setAiStopping", "aiStopping", "stopping");
  setter("setSummaryStarting", "summaryStarting", "summary");
  setter("setStudioAc", "studioAc", "studioAc");
  setter("setStudioDefaults", "studioDefaults", "studioDefaults");
  setter("setStudioPrompt", "studioPrompt", "studioPrompt");
  value.setJobs = vi.fn((jobs: unknown) => {
    value.jobs = jobs;
    value.events.push("jobs");
  });
  value.setFiles = vi.fn((files: unknown) => {
    value.files = files;
    value.events.push("files");
  });
  value.jobProgress ??= {};
  setter("setJobProgress", "jobProgress", "jobProgress");
  return value;
}

function actionsFor(s: MutableState, openOllamaApp = vi.fn(async () => undefined)) {
  return {
    actions: makeStudioActions(s as WSState, {
      viewFile: vi.fn(async () => undefined),
      openOllamaApp,
    }),
    openOllamaApp,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.aiAction.mockResolvedValue({ id: "result" });
  mocks.api.aiActionPrompts.mockResolvedValue([]);
  mocks.api.cancelJob.mockResolvedValue(undefined);
  mocks.api.cancelAsk.mockResolvedValue(undefined);
  mocks.api.deleteJob.mockResolvedValue(undefined);
  mocks.api.listFiles.mockResolvedValue([{ id: "result", name: "result.md" }]);
  mocks.api.listJobs.mockResolvedValue([]);
  mocks.api.resumeJob.mockResolvedValue(undefined);
  mocks.api.startDeepSummary.mockResolvedValue(undefined);
  mocks.api.startStudioJob.mockResolvedValue(undefined);
  mocks.resolveRefs.mockReturnValue({ refIds: [], cleaned: "" });
  mocks.studioPrompts.mockResolvedValue({
    flashcards: "Make useful flashcards.",
    mindmap: "Map the main ideas.",
    podcast: "Draft a short conversation.",
  });
});

describe("makeStudioActions.openStudioPrompt", () => {
  it("loads fabricated defaults once, clears autocomplete, and opens the requested Studio prompt", async () => {
    const s = state({ studioAc: { query: "map", start: 0 } });
    const { actions } = actionsFor(s);

    await actions.openStudioPrompt("mindmap", "folder-1");

    expect(mocks.studioPrompts).toHaveBeenCalledOnce();
    expect(s.studioDefaults).toEqual({
      flashcards: "Make useful flashcards.",
      mindmap: "Map the main ideas.",
      podcast: "Draft a short conversation.",
    });
    expect(s.studioAc).toBeNull();
    expect(s.studioPrompt).toEqual({
      kind: "mindmap",
      scope: "folder-1",
      text: "Map the main ideas.",
    });
  });

  it("uses already-loaded defaults without refetching them", async () => {
    const s = state({
      studioDefaults: {
        flashcards: "Cached cards.",
        mindmap: "Cached map.",
        podcast: "Cached podcast.",
      },
    });
    const { actions } = actionsFor(s);

    await actions.openStudioPrompt("podcast");

    expect(mocks.studioPrompts).not.toHaveBeenCalled();
    expect(s.studioPrompt).toEqual({ kind: "podcast", scope: undefined, text: "Cached podcast." });
  });

  it("keeps the Studio prompt usable with empty text when defaults fail to load", async () => {
    const s = state();
    mocks.studioPrompts.mockRejectedValueOnce(new Error("defaults unavailable"));
    const { actions } = actionsFor(s);

    await actions.openStudioPrompt("flashcards", "room-1");

    expect(s.setStudioDefaults).not.toHaveBeenCalled();
    expect(s.studioAc).toBeNull();
    expect(s.studioPrompt).toEqual({ kind: "flashcards", scope: "room-1", text: "" });
  });
});

describe("makeStudioActions.studioAcItems", () => {
  it("returns no fabricated mentions without an active autocomplete query", () => {
    const s = state({ studioAc: null });

    expect(actionsFor(s).actions.studioAcItems()).toEqual([]);
  });

  it("puts matching fabricated folders before capped matching files", () => {
    const folders = ["Archive notes", "Project notes", "Meeting notes", "Shared notes"]
      .map((name, index) => ({ id: `folder-${index + 1}`, name }));
    const files = Array.from({ length: 9 }, (_value, index) => ({
      id: `file-${index + 1}`,
      name: `note-${index + 1}.md`,
      mimeType: "text/markdown",
    }));
    const s = state({ files: [...files, { id: "other", name: "todo.md", mimeType: "text/markdown" }], folders, studioAc: { query: "note", start: 0 } });

    const items = actionsFor(s).actions.studioAcItems();

    expect(items).toHaveLength(10);
    expect(items.slice(0, 4)).toEqual(folders.map((folder) => ({
      key: `fo-${folder.id}`,
      label: `@${folder.name}/`,
      hint: "folder",
      insert: `@${folder.name}/ `,
    })));
    expect(items.slice(4)).toEqual(files.slice(0, 6).map((file) => ({
      key: `fi-${file.id}`,
      label: `@${file.name}`,
      hint: "text/markdown",
      insert: `@${file.name} `,
    })));
  });
});

describe("makeStudioActions.loadAiActions", () => {
  it("loads fabricated definitions once, then serves the cached definitions", async () => {
    const defs = [actionDef(), actionDef({ id: "translate", title: "Translate" })];
    mocks.api.aiActionPrompts.mockResolvedValueOnce(defs);
    const s = state();
    const { actions } = actionsFor(s);

    await expect(actions.loadAiActions()).resolves.toBe(defs);
    await expect(actions.loadAiActions()).resolves.toBe(defs);

    expect(mocks.api.aiActionPrompts).toHaveBeenCalledOnce();
    expect(s.setAiActionDefs).toHaveBeenCalledWith(defs);
    expect(s.aiActionDefs).toBe(defs);
    expect(s.pushToast).not.toHaveBeenCalled();
  });

  it("treats an already-cached empty fabricated definition list as loaded", async () => {
    const s = state({ aiActionDefs: [] });

    await expect(actionsFor(s).actions.loadAiActions()).resolves.toEqual([]);

    expect(mocks.api.aiActionPrompts).not.toHaveBeenCalled();
    expect(s.setAiActionDefs).not.toHaveBeenCalled();
  });

  it("reports a fabricated definition-load failure and returns the empty fallback", async () => {
    const s = state();
    mocks.api.aiActionPrompts.mockRejectedValueOnce(new Error("fabricated action catalog failure"));

    await expect(actionsFor(s).actions.loadAiActions()).resolves.toEqual([]);

    expect(s.setAiActionDefs).not.toHaveBeenCalled();
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: fabricated action catalog failure");
  });
});

describe("makeStudioActions.acceptMention", () => {
  it("replaces the active mention range and restores the textarea caret on the next frame", () => {
    const s = state({
      studioAc: { query: "re", start: 6 },
      studioPromptRef: {
        current: {
          focus: vi.fn(),
          selectionStart: 9,
          setSelectionRange: vi.fn(),
        },
      },
    });
    const { actions } = actionsFor(s);
    const prompt = { text: "Draft @re later" };
    let nextPrompt = prompt;
    const setPrompt = vi.fn((next) => {
      nextPrompt = typeof next === "function" ? next(nextPrompt) : next;
    });
    const originalFrame = Reflect.get(globalThis, "requestAnimationFrame");
    let frame: FrameRequestCallback | undefined;
    Reflect.set(globalThis, "requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    }));
    try {
      actions.acceptMention("@research", prompt, setPrompt);

      expect(nextPrompt).toEqual({ text: "Draft @research later" });
      expect(s.studioAc).toBeNull();
      if (!frame) throw new Error("mention caret frame was not requested");
      frame(0);
      expect(s.studioPromptRef.current.focus).toHaveBeenCalledOnce();
      expect(s.studioPromptRef.current.setSelectionRange).toHaveBeenCalledWith(15, 15);
    } finally {
      if (originalFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Reflect.set(globalThis, "requestAnimationFrame", originalFrame);
    }
  });

  it("uses the prompt end without a textarea and preserves a missing prompt", () => {
    const s = state();
    const { actions } = actionsFor(s);
    const prompt = { text: "Draft" };
    const setPrompt = vi.fn();
    const setMissing = vi.fn();
    const originalFrame = Reflect.get(globalThis, "requestAnimationFrame");
    Reflect.set(globalThis, "requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }));
    try {
      actions.acceptMention("@folder/", prompt, setPrompt);
      expect(setPrompt.mock.calls[0]?.[0](prompt)).toEqual({ text: "Draft@folder/" });

      actions.acceptMention("@ignored", null, setMissing);
      expect(setMissing.mock.calls[0]?.[0](null)).toBeNull();
      expect(s.setStudioAc).toHaveBeenCalledTimes(2);
    } finally {
      if (originalFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Reflect.set(globalThis, "requestAnimationFrame", originalFrame);
    }
  });
});

describe("makeStudioActions.stopAiAction", () => {
  it("marks a running fabricated AI action as stopping after cancellation reaches the API", async () => {
    const s = state({ aiOpId: "ai-operation-1" });
    const { actions } = actionsFor(s);

    await actions.stopAiAction();

    expect(mocks.api.cancelAsk).toHaveBeenCalledWith("ai-operation-1");
    expect(s.aiStopping).toBe(true);
    expect(s.pushToast).not.toHaveBeenCalled();
  });

  it("does not cancel without an operation id or after Stop is already pressed", async () => {
    const absent = state({ aiOpId: null });
    const alreadyStopping = state({ aiOpId: "ai-operation-1", aiStopping: true });

    await actionsFor(absent).actions.stopAiAction();
    await actionsFor(alreadyStopping).actions.stopAiAction();

    expect(mocks.api.cancelAsk).not.toHaveBeenCalled();
    expect(absent.setAiStopping).not.toHaveBeenCalled();
    expect(alreadyStopping.setAiStopping).not.toHaveBeenCalled();
  });

  it("makes a fabricated cancellation failure visible and re-enables Stop", async () => {
    const s = state({ aiOpId: "ai-operation-1" });
    mocks.api.cancelAsk.mockRejectedValueOnce(new Error("host unavailable"));
    const { actions } = actionsFor(s);

    await actions.stopAiAction();

    expect(s.aiStopping).toBe(false);
    expect(s.pushToast).toHaveBeenCalledWith("error", "Couldn't stop it: Error: host unavailable");
  });
});

describe("makeStudioActions.runAiActionFromModal", () => {
  it("starts and settles the modal run while forwarding de-duplicated references", async () => {
    const s = state({
      aiPrompt: actionPrompt({
        def: actionDef({ needsQuestion: true }),
        question: "  meeting notes  ",
      }),
    });
    mocks.resolveRefs.mockReturnValue({ refIds: ["mentioned", "typed"], cleaned: "unused" });
    const { actions } = actionsFor(s);

    await actions.runAiActionFromModal();

    const [, options] = mocks.api.aiAction.mock.calls[0];
    expect(mocks.api.aiAction).toHaveBeenCalledWith("summarize", {
      scope: "room-1",
      refs: ["saved", "mentioned", "typed"],
      instructions: "Keep the requested tone for @notes.md",
      question: "  meeting notes  ",
      opId: options.opId,
    });
    expect(options.opId).toMatch(/^ai-\d+-[a-z0-9]+$/);
    expect(mocks.api.listFiles).toHaveBeenCalledOnce();
    expect(s.files).toEqual([{ id: "result", name: "result.md" }]);
    expect(s.events).toEqual([
      "busy:true",
      `op:${options.opId}`,
      "stopping:false",
      "files",
      "prompt:null",
      "busy:false",
      "op:null",
      "stopping:false",
    ]);
  });

  it("keeps the prompt, reports the API error, and clears busy state after a failed action", async () => {
    const s = state();
    const originalPrompt = s.aiPrompt;
    mocks.api.aiAction.mockRejectedValue(new Error("request failed"));
    const { actions, openOllamaApp } = actionsFor(s);

    await actions.runAiActionFromModal();

    expect(mocks.api.listFiles).not.toHaveBeenCalled();
    expect(s.aiPrompt).toBe(originalPrompt);
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: request failed");
    expect(openOllamaApp).not.toHaveBeenCalled();
    expect(s.events).toEqual([
      "busy:true",
      expect.stringMatching(/^op:ai-\d+-[a-z0-9]+$/),
      "stopping:false",
      "busy:false",
      "op:null",
      "stopping:false",
    ]);
  });

  it("does not start a busy, absent, or unanswered question/language action", async () => {
    const cases = [
      state({ aiPrompt: null }),
      state({ aiBusy: true }),
      state({ aiPrompt: actionPrompt({ def: actionDef({ needsQuestion: true }), question: "  " }) }),
      state({ aiPrompt: actionPrompt({ def: actionDef({ needsLanguage: true }), question: "  " }) }),
    ];

    for (const s of cases) await actionsFor(s).actions.runAiActionFromModal();

    expect(mocks.api.aiAction).not.toHaveBeenCalled();
    for (const s of cases) {
      expect(s.setAiBusy).not.toHaveBeenCalled();
      expect(s.events).toEqual([]);
    }
  });
});

describe("makeStudioActions.startDeepSummary", () => {
  it("starts a fresh fake summary, refreshes Activity, and clears its optimistic state", async () => {
    const s = state({
      jobs: [{ id: "finished", kind: "deep_summary", status: "done" }],
    });
    mocks.api.listJobs.mockResolvedValue([{ id: "fresh", kind: "deep_summary", status: "queued" }]);
    const { actions } = actionsFor(s);

    await actions.startDeepSummary();

    expect(mocks.api.startDeepSummary).toHaveBeenCalledOnce();
    expect(mocks.api.listJobs).toHaveBeenCalledOnce();
    expect(s.jobs).toEqual([{ id: "fresh", kind: "deep_summary", status: "queued" }]);
    expect(s.pushToast).toHaveBeenCalledWith(
      "info",
      "Summarizing in the background — you can keep working.",
    );
    expect(s.events).toEqual(["summary:true", "jobs", "summary:false"]);
  });

  it("points to an active fake summary instead of starting another one", async () => {
    const running = state({ jobs: [{ id: "running", kind: "deep_summary", status: "running" }] });
    const queued = state({ jobs: [{ id: "queued", kind: "deep_summary", status: "queued" }] });

    await actionsFor(running).actions.startDeepSummary();
    await actionsFor(queued).actions.startDeepSummary();

    expect(mocks.api.startDeepSummary).not.toHaveBeenCalled();
    expect(mocks.api.resumeJob).not.toHaveBeenCalled();
    expect(running.pushToast).toHaveBeenCalledWith("info", "Already summarizing — it's in Activity.");
    expect(queued.pushToast).toHaveBeenCalledWith("info", "Already summarizing — it's in Activity.");
  });

  it("resumes every paused or errored fake summary and refreshes Activity", async () => {
    const paused = state({ jobs: [{ id: "paused", kind: "deep_summary", status: "paused" }] });
    const failed = state({ jobs: [{ id: "failed", kind: "deep_summary", status: "error" }] });
    const { actions: pausedActions } = actionsFor(paused);
    const { actions: failedActions } = actionsFor(failed);

    await pausedActions.startDeepSummary();
    await failedActions.startDeepSummary();

    expect(mocks.api.resumeJob).toHaveBeenNthCalledWith(1, "paused");
    expect(mocks.api.resumeJob).toHaveBeenNthCalledWith(2, "failed");
    expect(mocks.api.listJobs).toHaveBeenCalledTimes(2);
    expect(paused.pushToast).toHaveBeenCalledWith("info", "Resuming the room summary…");
    expect(failed.pushToast).toHaveBeenCalledWith("info", "Resuming the room summary…");
  });

  it("refreshes fake Activity and clears optimistic state after a summary-start error", async () => {
    const s = state();
    mocks.api.startDeepSummary.mockRejectedValueOnce(new Error("fabricated model request failed"));
    mocks.api.listJobs.mockResolvedValueOnce([{ id: "stalled", kind: "deep_summary", status: "error" }]);
    const { actions, openOllamaApp } = actionsFor(s);

    await actions.startDeepSummary();

    expect(mocks.api.listJobs).toHaveBeenCalledOnce();
    expect(s.jobs).toEqual([{ id: "stalled", kind: "deep_summary", status: "error" }]);
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: fabricated model request failed");
    expect(openOllamaApp).not.toHaveBeenCalled();
    expect(s.events).toEqual(["summary:true", "jobs", "summary:false"]);
  });

  it("does not start another summary while its optimistic start is already pending", async () => {
    const s = state({ summaryStarting: true });

    await actionsFor(s).actions.startDeepSummary();

    expect(mocks.api.startDeepSummary).not.toHaveBeenCalled();
    expect(s.events).toEqual([]);
  });
});

describe("makeStudioActions activity and modal commands", () => {
  it("keeps the current Activity cards when a refresh fails", async () => {
    const jobs = [{ id: "existing", kind: "create", status: "done" }];
    const s = state({ jobs });
    mocks.api.listJobs.mockRejectedValueOnce(new Error("room closed"));

    await actionsFor(s).actions.refreshJobs();

    expect(s.jobs).toBe(jobs);
    expect(s.setJobs).not.toHaveBeenCalled();
  });

  it("pauses and dismisses fake jobs while removing only the matching progress", async () => {
    const s = state({ jobProgress: { keep: { progress: 0.5 }, remove: { progress: 0.2 } } });
    const { actions } = actionsFor(s);

    await actions.pauseJob("pause-me");
    await actions.dismissJob("remove");

    expect(mocks.api.cancelJob).toHaveBeenCalledWith("pause-me");
    expect(mocks.api.deleteJob).toHaveBeenCalledWith("remove");
    expect(s.jobProgress).toEqual({ keep: { progress: 0.5 } });
    expect(mocks.api.listJobs).toHaveBeenCalledOnce();
  });

  it("starts a fake Studio job and launches the same behavior from its modal", async () => {
    const s = state({ studioPrompt: { kind: "podcast", scope: "folder-1", text: "Use @notes.md" } });
    mocks.resolveRefs.mockReturnValue({ refIds: ["file-1"], cleaned: "Use" });
    const { actions } = actionsFor(s);

    await actions.runStudio("mindmap", "room-1", "Map it", ["file-2"]);
    await actions.runStudioFromModal();

    expect(mocks.api.startStudioJob).toHaveBeenNthCalledWith(1, "mindmap", "room-1", "Map it", ["file-2"]);
    expect(mocks.api.startStudioJob).toHaveBeenNthCalledWith(2, "podcast", "folder-1", "Use @notes.md", ["file-1"]);
    expect(s.studioPrompt).toBeNull();
    expect(s.pushToast).toHaveBeenCalledWith("info", "Generating in the background — you can keep working.");
  });

  it("does not run an absent Studio modal and exposes a selected AI action only while idle", async () => {
    const idle = state({ studioPrompt: null });
    const busy = state({ aiBusy: true });
    const def = actionDef({ defaultPrompt: "Translate exactly" });

    await actionsFor(idle).actions.runStudioFromModal();
    actionsFor(idle).actions.openAiAction(def, "folder-2", ["file-4"]);
    actionsFor(busy).actions.openAiAction(def, null, null);

    expect(mocks.api.startStudioJob).not.toHaveBeenCalled();
    expect(idle.aiPrompt).toEqual({ def, scope: "folder-2", refs: ["file-4"], text: "Translate exactly", question: "" });
    expect(busy.setAiPrompt).not.toHaveBeenCalled();
  });
});
