import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  addMemory: vi.fn(),
  ask: vi.fn(),
  browserPageSelection: vi.fn(),
  browserPageText: vi.fn(),
  cancelAsk: vi.fn(),
  createChat: vi.fn(),
  deleteChat: vi.fn(),
  deleteMemory: vi.fn(),
  deleteMessage: vi.fn(),
  getMessages: vi.fn(),
  handoffContext: vi.fn(),
  importImageBytes: vi.fn(),
  listChats: vi.fn(),
  listFiles: vi.fn(),
  listMemories: vi.fn(),
  listSpecialists: vi.fn(),
  memorySuggestion: vi.fn(),
  renameChat: vi.fn(),
  resolveEditApproval: vi.fn(),
  runCommand: vi.fn(),
  saveGeneratedFile: vi.fn(),
}));
const composer = vi.hoisted(() => ({
  fileToBase64: vi.fn(),
  parsed: { args: "", refIds: [] } as Record<string, unknown>,
  parseComposer: vi.fn(),
  specialistItems: vi.fn(),
  specialistNote: vi.fn(),
  tokenAtCaret: vi.fn(),
  uniqueFileName: vi.fn(),
}));
const readable = vi.hoisted(() => ({
  cues: [] as Array<{ text: string }>,
  html: "",
  ocr: "",
}));
const browserScope = vi.hoisted(() => ({
  pageContext: vi.fn(),
  withPageContext: vi.fn(),
  withPreamble: vi.fn(),
  withSelectionContext: vi.fn(),
}));
const room = vi.hoisted(() => ({
  prefersReducedMotion: vi.fn(() => false),
}));
const voiceMocks = vi.hoisted(() => ({
  beginTurn: vi.fn(),
  cancelAll: vi.fn(),
  endOfTurn: vi.fn(),
  ensureUnlocked: vi.fn(),
}));

vi.mock("../api", () => ({
  api: bridge,
  memorySuggestion: bridge.memorySuggestion,
}));
vi.mock("../viewers/util", () => ({ ocrBody: () => readable.ocr }));
vi.mock("../viewers/htmlText", () => ({ textOf: () => readable.html }));
vi.mock("../viewers/subtitles", () => ({ parseCues: () => readable.cues }));
vi.mock("./composer", () => ({
  fileToBase64: composer.fileToBase64,
  hoistSkill: (text: string, skill: string) => `/${skill} ${text}`.trim(),
  hoistTag: (text: string, specialist: string) => `*${specialist} ${text}`.trim(),
  parseComposer: composer.parseComposer,
  specialistErrorMessage: (key: string) => `Specialist ${key} is unavailable.`,
  specialistItems: composer.specialistItems,
  specialistNote: composer.specialistNote,
  tokenAtCaret: composer.tokenAtCaret,
  uniqueFileName: composer.uniqueFileName,
}));
vi.mock("./guard", () => ({
  runGuarded: async (state: { pushToast(kind: string, message: string): void }, run: (id: string) => Promise<unknown>, options: {
    begin?: () => void;
    finish?: () => Promise<void> | void;
    handle?: (message: string) => boolean;
    ignore?: (message: string) => boolean;
    onError?: (message: string) => Promise<void> | void;
  }) => {
    options.begin?.();
    try {
      await run("ask-1");
    } catch (error) {
      const message = String(error);
      if (!options.ignore?.(message)) {
        if (!options.handle?.(message)) state.pushToast("error", message);
        await options.onError?.(message);
      }
    } finally {
      await options.finish?.();
    }
  },
}));
vi.mock("../rooms/helpers", () => ({
  prefersReducedMotion: room.prefersReducedMotion,
}));
vi.mock("./markup", () => ({
  lostReplyNotice: () => null,
  speakerName: () => "You",
  splitMarkupBlocks: (text: string) => ({ text }),
}));
vi.mock("./browserScope", () => ({
  ROOM_ONLY: { scope: "room", label: "this room", sendsPageText: false, preamble: "", fileIds: [] },
  pageContext: browserScope.pageContext,
  withPageContext: browserScope.withPageContext,
  withSelectionContext: browserScope.withSelectionContext,
  withPreamble: browserScope.withPreamble,
}));
vi.mock("./constants", () => ({ HELP_COMMAND: { name: "help", summary: "Help", usage: "#help" } }));
vi.mock("./voice", () => ({
  beginTurn: voiceMocks.beginTurn,
  cancelAll: voiceMocks.cancelAll,
  endOfTurn: voiceMocks.endOfTurn,
  ensureUnlocked: voiceMocks.ensureUnlocked,
}));

import { currentTurnScope, makeChatActions, setTurnScope, subscribeTurnScope } from "./chatActions";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function resetBridge() {
  for (const mock of Object.values(bridge)) mock.mockReset();
  bridge.addMemory.mockResolvedValue({ id: "memory", createdAt: new Date().toISOString() });
  bridge.ask.mockResolvedValue(undefined);
  bridge.browserPageSelection.mockResolvedValue({ title: "Page", url: "https://example.test", text: "selected", total: 8 });
  bridge.browserPageText.mockResolvedValue({ title: "Page", url: "https://example.test", text: "page text" });
  bridge.cancelAsk.mockResolvedValue({ stopped: [] });
  bridge.createChat.mockResolvedValue({ id: "chat-new" });
  bridge.deleteChat.mockResolvedValue(undefined);
  bridge.deleteMemory.mockResolvedValue(undefined);
  bridge.deleteMessage.mockResolvedValue(undefined);
  bridge.getMessages.mockResolvedValue([]);
  bridge.handoffContext.mockResolvedValue({ effects: null });
  bridge.importImageBytes.mockResolvedValue({ id: "pasted-image" });
  bridge.listChats.mockResolvedValue([]);
  bridge.listFiles.mockResolvedValue([]);
  bridge.listMemories.mockResolvedValue([]);
  bridge.listSpecialists.mockResolvedValue([]);
  bridge.memorySuggestion.mockResolvedValue({ worth: false, fact: "" });
  bridge.renameChat.mockResolvedValue(undefined);
  bridge.resolveEditApproval.mockResolvedValue(undefined);
  bridge.runCommand.mockResolvedValue(undefined);
  bridge.saveGeneratedFile.mockResolvedValue({ id: "generated", name: "AI note.md" });
}

function resetComposer() {
  composer.fileToBase64.mockReset();
  composer.parsed = { args: "", refIds: [] };
  composer.parseComposer.mockReset();
  composer.parseComposer.mockImplementation(() => composer.parsed);
  composer.specialistItems.mockReset();
  composer.specialistItems.mockReturnValue([]);
  composer.specialistNote.mockReset().mockImplementation((specialists, error, query) => {
    if (specialists === null) {
      return error ? `The specialists couldn't be loaded: ${error}` : "Looking up this room's specialists…";
    }
    if (specialists.length === 0) return "This room has no specialists to hand a turn to right now.";
    return query === "writer" ? "" : `No specialist here matches "${query}".`;
  });
  composer.tokenAtCaret.mockReset();
  composer.tokenAtCaret.mockReturnValue(null);
  composer.uniqueFileName.mockReset().mockImplementation((name: string) => name);
}

function state(overrides: Record<string, unknown> = {}) {
  const value: Record<string, any> = {
    activeChatId: "chat-1",
    activeChatIdRef: { current: "chat-1" },
    asking: false,
    attachments: [],
    commands: [],
    composerRef: { current: { focus: vi.fn(), setSelectionRange: vi.fn() } },
    editedRef: { current: new Set<string>() },
    files: [],
    folders: [],
    handoffStarting: false,
    memAutoSaveRef: { current: false },
    messages: [],
    model: "model",
    openFile: null,
    openFileRef: { current: null },
    question: "",
    renameDraft: "",
    renaming: false,
    runs: {},
    saveDraft: null,
    skills: [],
    specialists: null,
    beginRun: vi.fn(),
    endRun: vi.fn(),
    pushToast: vi.fn(),
    runIdOf: vi.fn(() => null),
    setAc: vi.fn((next) => { value.ac = next; }),
    setAskPrivacy: vi.fn(),
    setActiveChatId: vi.fn((next) => {
      value.activeChatId = next;
      value.activeChatIdRef.current = next;
    }),
    setAttachments: vi.fn((next) => {
      value.attachments = typeof next === "function" ? next(value.attachments) : next;
    }),
    setChats: vi.fn(),
    setChatUsage: vi.fn(),
    setEditApprovals: vi.fn((update) => update([])),
    setFiles: vi.fn(),
    setHandoffStarting: vi.fn((next) => { value.handoffStarting = next; }),
    setMemSuggestion: vi.fn(),
    setMemories: vi.fn(),
    setMessages: vi.fn((update) => {
      value.messages = typeof update === "function" ? update(value.messages) : update;
    }),
    setQuestion: vi.fn((next) => { value.question = next; }),
    setRenameDraft: vi.fn((next) => { value.renameDraft = next; }),
    setRenaming: vi.fn((next) => { value.renaming = next; }),
    setSaveDraft: vi.fn((next) => { value.saveDraft = next; }),
    setShowHelp: vi.fn(),
    setSpeakingMsgId: vi.fn(),
    setSpecialists: vi.fn((next) => { value.specialists = next; }),
    setSpecialistsError: vi.fn((next) => { value.specialistsError = next; }),
    setUndoByMsg: vi.fn(),
    ...overrides,
  };
  return value;
}

function deps() {
  return {
    downloadModel: vi.fn(async () => undefined),
    openOllamaApp: vi.fn(async () => undefined),
    playSealSound: vi.fn(),
    refreshAi: vi.fn(async () => undefined),
    viewFile: vi.fn(async () => undefined),
  };
}

function keyboardEvent(key: string, shiftKey = false) {
  return {
    key,
    shiftKey,
    nativeEvent: { isComposing: false, stopImmediatePropagation: vi.fn() },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

beforeEach(() => {
  resetBridge();
  resetComposer();
  readable.cues = [];
  readable.html = "";
  readable.ocr = "";
  browserScope.pageContext.mockReset().mockImplementation((page) => page.text ? page : null);
  browserScope.withPageContext.mockReset().mockImplementation((question: string, page: { title: string }) => `[${page.title}] ${question}`);
  browserScope.withSelectionContext.mockReset().mockImplementation((question: string, selection: { text: string }) => `[selection:${selection.text}] ${question}`);
  browserScope.withPreamble.mockReset().mockImplementation((question: string, preamble: string) => (preamble ? `${preamble}\n${question}` : question));
  room.prefersReducedMotion.mockReset();
  room.prefersReducedMotion.mockReturnValue(false);
  for (const mock of Object.values(voiceMocks)) mock.mockReset();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: vi.fn(async () => undefined) } },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  setTurnScope({
    scope: "room",
    label: "this room",
    available: ["room"],
    placeholder: "Ask this room",
    sendsPageText: false,
    preamble: "",
    fileIds: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});

describe("chat actions", () => {
  it("closes blank or inactive rename forms without calling fabricated chat APIs", async () => {
    const blank = state({ renameDraft: "  \n", renaming: true });
    await makeChatActions(blank as never, vi.fn(), deps()).commitRename();
    expect(blank.renaming).toBe(false);
    expect(bridge.renameChat).not.toHaveBeenCalled();
    expect(bridge.listChats).not.toHaveBeenCalled();

    const inactive = state({ activeChatId: null, renameDraft: "A new title", renaming: true });
    await makeChatActions(inactive as never, vi.fn(), deps()).commitRename();
    expect(inactive.renaming).toBe(false);
    expect(bridge.renameChat).not.toHaveBeenCalled();
    expect(bridge.listChats).not.toHaveBeenCalled();
  });

  it("trims and saves a fabricated chat title before refreshing the list", async () => {
    const refreshed = [{ id: "chat-1", title: "Renamed chat" }];
    bridge.listChats.mockResolvedValue(refreshed);
    const s = state({ renameDraft: "  Renamed chat  ", renaming: true });

    await makeChatActions(s as never, vi.fn(), deps()).commitRename();

    expect(s.renaming).toBe(false);
    expect(bridge.renameChat).toHaveBeenCalledWith("chat-1", "Renamed chat");
    expect(bridge.listChats).toHaveBeenCalledOnce();
    expect(s.setChats).toHaveBeenCalledWith(refreshed);
  });

  it("closes the form but preserves the rejected fabricated rename error for its caller", async () => {
    bridge.renameChat.mockRejectedValue(new Error("fake rename refusal"));
    const s = state({ renameDraft: "Blocked name", renaming: true });

    await expect(makeChatActions(s as never, vi.fn(), deps()).commitRename())
      .rejects.toThrow("fake rename refusal");
    expect(s.renaming).toBe(false);
    expect(bridge.listChats).not.toHaveBeenCalled();
    expect(s.pushToast).not.toHaveBeenCalled();
  });

  it("copies a fabricated conversation with transcript speaker and handoff boundaries", async () => {
    const s = state({
      chats: [{ id: "chat-1", title: "Project discussion" }],
      messages: [
        { id: "user-1", role: "user", content: "What changed?", sources: [], createdAt: "", effects: null },
        { id: "assistant-1", role: "assistant", content: "**A concise answer**", sources: [], createdAt: "", effects: null },
        { id: "handoff-1", role: "assistant", kind: "handoff", content: "Earlier details", sources: [], createdAt: "", effects: null },
      ],
    });

    makeChatActions(s as never, vi.fn(), deps()).copyConversation();
    await Promise.resolve();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "# Project discussion\n\n**You**\n\nWhat changed?\n\n---\n\n**You**\n\n**A concise answer**\n\n---\n\n**Context summarized, continuing**\n\nEarlier details\n",
    );
    expect(s.pushToast).toHaveBeenCalledWith("success", "The whole chat was copied to the clipboard.");
  });

  it("reports empty and clipboard-refused fabricated conversation copies", async () => {
    const empty = state({ messages: [] });
    makeChatActions(empty as never, vi.fn(), deps()).copyConversation();
    expect(empty.pushToast).toHaveBeenCalledWith("info", "There's nothing in this chat yet.");

    const deniedClipboard = vi.fn().mockRejectedValue(new Error("fake denied"));
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: deniedClipboard } },
    });
    const denied = state({
      chats: [],
      messages: [{ id: "user-1", role: "user", content: "Still private", sources: [], createdAt: "", effects: null }],
    });
    makeChatActions(denied as never, vi.fn(), deps()).copyConversation();
    await Promise.resolve();
    await Promise.resolve();

    expect(deniedClipboard).toHaveBeenCalledWith("# Chat\n\n**You**\n\nStill private\n");
    expect(denied.pushToast).toHaveBeenCalledWith(
      "error",
      "Couldn't copy — macOS refused clipboard access to Arcelle.",
    );
  });

  it("copies the visible form of every supported text-bearing file", () => {
    const s = state({ openFile: { content: { kind: "image", text: "raw image" } } });
    const actions = makeChatActions(s as never, vi.fn(), deps());
    readable.ocr = "visible OCR";
    actions.copyAllText();

    s.openFile = { content: { kind: "audio", text: "(transcribed from recording) Heard words" } };
    actions.copyAllText();
    s.openFile = { content: { kind: "audio", text: "Already clean transcript" } };
    actions.copyAllText();
    readable.html = "Visible HTML";
    s.openFile = { content: { kind: "html", text: "<p>Visible HTML</p>" } };
    actions.copyAllText();
    readable.cues = [{ text: "First cue" }, { text: "Second cue" }];
    s.openFile = { content: { kind: "subtitle", text: "00:00" } };
    actions.copyAllText();
    s.openFile = { content: { kind: "text", text: "Plain text" } };
    actions.copyAllText();

    expect(navigator.clipboard.writeText).toHaveBeenNthCalledWith(1, "visible OCR");
    expect(navigator.clipboard.writeText).toHaveBeenNthCalledWith(2, "Heard words");
    expect(navigator.clipboard.writeText).toHaveBeenNthCalledWith(3, "Already clean transcript");
    expect(navigator.clipboard.writeText).toHaveBeenNthCalledWith(4, "Visible HTML");
    expect(navigator.clipboard.writeText).toHaveBeenNthCalledWith(5, "First cue\n\nSecond cue");
    expect(navigator.clipboard.writeText).toHaveBeenNthCalledWith(6, "Plain text");
  });

  it("moves, accepts, and dismisses autocomplete without leaking keys", () => {
    const s = state({ ac: { kind: "agent", query: "", start: 0, index: 0 } });
    composer.specialistItems.mockReturnValue([
      { key: "waiting", label: "Waiting", hint: "", insert: "", disabled: true },
      { key: "writer", label: "Writer", hint: "", insert: "*writer " },
    ]);
    const actions = makeChatActions(s as never, vi.fn(), deps());

    const down = keyboardEvent("ArrowDown");
    actions.onComposerKeyDown(down as never);
    expect(down.preventDefault).toHaveBeenCalledOnce();
    expect(s.ac.index).toBe(1);

    const up = keyboardEvent("ArrowUp");
    actions.onComposerKeyDown(up as never);
    expect(s.ac.index).toBe(1);

    const enter = keyboardEvent("Enter");
    actions.onComposerKeyDown(enter as never);
    expect(s.question).toBe("*writer ");
    expect(s.ac).toBeNull();

    s.ac = { kind: "agent", query: "", start: 0, index: 0 };
    s.question = "*";
    composer.tokenAtCaret.mockReturnValue({ kind: "agent", query: "", start: 0 });
    const escape = keyboardEvent("Escape");
    actions.onComposerKeyDown(escape as never);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(escape.stopPropagation).toHaveBeenCalledOnce();
    expect(escape.nativeEvent.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(s.question).toBe("");
  });

  it("keeps an all-disabled menu selected and leaves unrelated keys to the composer", () => {
    const s = state({ ac: { kind: "agent", query: "", start: 0, index: 1 } });
    composer.specialistItems.mockReturnValue([
      { key: "first", label: "First", hint: "", insert: "", disabled: true },
      { key: "second", label: "Second", hint: "", insert: "", disabled: true },
    ]);
    const actions = makeChatActions(s as never, vi.fn(), deps());

    const down = keyboardEvent("ArrowDown");
    actions.onComposerKeyDown(down as never);
    expect(down.preventDefault).toHaveBeenCalledOnce();
    expect(s.ac).toEqual({ kind: "agent", query: "", start: 0, index: 1 });

    const unrelated = keyboardEvent("Home");
    actions.onComposerKeyDown(unrelated as never);
    expect(unrelated.preventDefault).not.toHaveBeenCalled();
    expect(s.ac).toEqual({ kind: "agent", query: "", start: 0, index: 1 });
  });

  it("submits an unmodified Enter through the fabricated ask boundary", async () => {
    const s = state({ question: "Ask safely" });
    let resolveAsked: (() => void) | undefined;
    const asked = new Promise<void>((resolve) => { resolveAsked = resolve; });
    bridge.ask.mockImplementation(async () => { resolveAsked?.(); });
    const enter = keyboardEvent("Enter");

    makeChatActions(s as never, vi.fn(), deps()).onComposerKeyDown(enter as never);
    await asked;

    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(voiceMocks.ensureUnlocked).toHaveBeenCalledOnce();
    expect(bridge.ask).toHaveBeenCalledWith("chat-1", "Ask safely", [], expect.any(String), null, undefined);
  });

  it("leaves Shift+Enter and a fabricated composition key for native textarea editing", () => {
    const s = state({ question: "Keep composing" });
    const actions = makeChatActions(s as never, vi.fn(), deps());
    const shiftedEnter = keyboardEvent("Enter", true);
    const composition = keyboardEvent("Process");
    composition.nativeEvent.isComposing = true;

    actions.onComposerKeyDown(shiftedEnter as never);
    actions.onComposerKeyDown(composition as never);

    expect(shiftedEnter.preventDefault).not.toHaveBeenCalled();
    expect(composition.preventDefault).not.toHaveBeenCalled();
    expect(voiceMocks.ensureUnlocked).not.toHaveBeenCalled();
    expect(bridge.ask).not.toHaveBeenCalled();
    expect(s.question).toBe("Keep composing");
  });

  it("prevents Tab from submitting a disabled autocomplete item", () => {
    const s = state({ ac: { kind: "agent", query: "", start: 0, index: 0 } });
    composer.specialistItems.mockReturnValue([{ key: "waiting", label: "Waiting", hint: "", insert: "", disabled: true }]);
    const tab = keyboardEvent("Tab");

    makeChatActions(s as never, vi.fn(), deps()).onComposerKeyDown(tab as never);

    expect(tab.preventDefault).toHaveBeenCalledOnce();
    expect(s.ac).toEqual({ kind: "agent", query: "", start: 0, index: 0 });
    expect(s.question).toBe("");
    expect(bridge.ask).not.toHaveBeenCalled();
  });

  it("accepts the selected autocomplete item with Tab", () => {
    const s = state({ ac: { kind: "agent", query: "", start: 0, index: 0 } });
    composer.specialistItems.mockReturnValue([{ key: "writer", label: "Writer", hint: "", insert: "*writer " }]);
    const tab = keyboardEvent("Tab");

    makeChatActions(s as never, vi.fn(), deps()).onComposerKeyDown(tab as never);

    expect(tab.preventDefault).toHaveBeenCalledOnce();
    expect(s.question).toBe("*writer ");
    expect(s.ac).toBeNull();
  });

  it("preserves help and validation refusals before any turn is sent", async () => {
    const s = state({ question: "#help" });
    const actions = makeChatActions(s as never, vi.fn(), deps());
    await actions.send();
    expect(s.setShowHelp).toHaveBeenCalledWith(true);
    expect(s.question).toBe("");
    expect(bridge.ask).not.toHaveBeenCalled();

    s.question = "/missing";
    composer.parsed = { args: "/missing", refIds: [], skillError: "missing" };
    await actions.send();
    expect(s.pushToast).toHaveBeenLastCalledWith(
      "error",
      "/missing isn't an enabled skill. Type / to choose from enabled skills.",
    );
    expect(bridge.ask).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an unavailable specialist",
      "*missing",
      { args: "*missing", refIds: [], specialistError: "missing" },
      [],
      "Specialist missing is unavailable.",
    ],
    [
      "conflicting specialist, skill, and action tags",
      "*writer /review #minutes",
      { args: "*writer /review #minutes", refIds: [], tagConflict: true },
      [],
      "A message can name a specialist (*), a skill (/) or an action (#) — not two of them.",
    ],
    [
      "an unknown command with available commands",
      "#unknown",
      { args: "#unknown", refIds: [], commandError: "unknown" },
      [{ name: "minutes" }, { name: "outline" }],
      "#unknown isn't a command. Try: #minutes, #outline",
    ],
    [
      "an unknown command with no available commands",
      "#unknown",
      { args: "#unknown", refIds: [], commandError: "unknown" },
      [],
      "#unknown isn't a command. Try: (none available)",
    ],
    [
      "an unavailable skill",
      "/missing",
      { args: "/missing", refIds: [], skillError: "missing" },
      [],
      "/missing isn't an enabled skill. Type / to choose from enabled skills.",
    ],
  ])("refuses %s before using any fabricated send API", async (_kind, question, parsed, commands, error) => {
    const s = state({ question, commands });
    composer.parsed = parsed;

    await makeChatActions(s as never, vi.fn(), deps()).send();

    expect(s.pushToast).toHaveBeenCalledExactlyOnceWith("error", error);
    expect(bridge.ask).not.toHaveBeenCalled();
    expect(bridge.runCommand).not.toHaveBeenCalled();
    expect(s.question).toBe(question);
  });

  it("sends commands and rewrites a validated message using fake IPC only", async () => {
    const s = state({ question: "#minutes" });
    const actions = makeChatActions(s as never, vi.fn(), deps());
    composer.parsed = { command: "minutes", args: "", refIds: ["file-1"] };
    await actions.send();
    expect(bridge.runCommand).toHaveBeenCalledWith(
      "chat-1", "minutes", "", ["file-1"], "#minutes", expect.any(String),
    );
    expect(s.setAttachments).toHaveBeenCalledWith([]);

    s.question = "summarize this";
    s.attachments = [{ id: "pinned" }];
    composer.parsed = { args: "summarize this", refIds: ["mentioned"] };
    setTurnScope({
      scope: "room",
      label: "this room",
      available: ["room"],
      placeholder: "Ask this room",
      sendsPageText: false,
      preamble: "",
      fileIds: ["scope-file"],
    });
    await actions.send();
    expect(bridge.ask).toHaveBeenLastCalledWith(
      "chat-1",
      "summarize this",
      ["pinned", "mentioned", "scope-file"],
      expect.any(String),
      null,
      undefined,
    );

    s.messages = [
      { id: "user-1", role: "user", content: "old", sources: [], createdAt: "", effects: null },
      { id: "assistant-1", role: "assistant", content: "old reply", sources: [], createdAt: "", effects: null },
    ];
    composer.parsed = { command: "minutes", args: "", refIds: ["file-2"] };
    await actions.editAndResend("user-1", "#minutes");
    expect(bridge.deleteMessage.mock.calls.slice(-2)).toEqual([["assistant-1"], ["user-1"]]);
    expect(bridge.runCommand).toHaveBeenLastCalledWith(
      "chat-1", "minutes", "", ["file-2"], "#minutes", expect.any(String),
    );
  });

  it("removes the edited tail and sends an accepted replacement through fabricated APIs", async () => {
    const original = { id: "user-1", role: "user", content: "Original", sources: [], createdAt: "", effects: null };
    const reply = { id: "assistant-1", role: "assistant", content: "Old reply", sources: [], createdAt: "", effects: null };
    const s = state({ messages: [original, reply] });
    composer.parsed = { args: "rewritten", refIds: ["mentioned"] };
    setTurnScope({
      scope: "room",
      label: "this room",
      available: ["room"],
      placeholder: "Ask this room",
      sendsPageText: false,
      preamble: "Scope context",
      fileIds: ["mentioned", "scope-file"],
    });

    await makeChatActions(s as never, vi.fn(), deps()).editAndResend("user-1", "  rewritten  ");

    expect(bridge.deleteMessage.mock.calls.slice(0, 2)).toEqual([["assistant-1"], ["user-1"]]);
    expect(bridge.ask).toHaveBeenCalledWith(
      "chat-1",
      "Scope context\nrewritten",
      ["mentioned", "scope-file"],
      expect.any(String),
      null,
      undefined,
    );
  });

  it("refuses an invalid rewrite before deleting the existing conversation tail", async () => {
    const original = { id: "user-1", role: "user", content: "Original", sources: [], createdAt: "", effects: null };
    const s = state({ messages: [original] });
    composer.parsed = { args: "/missing", refIds: [], skillError: "missing" };

    await makeChatActions(s as never, vi.fn(), deps()).editAndResend("user-1", "/missing");

    expect(s.pushToast).toHaveBeenCalledExactlyOnceWith(
      "error",
      "/missing isn't an enabled skill. Type / to choose from enabled skills.",
    );
    expect(bridge.deleteMessage).not.toHaveBeenCalled();
    expect(bridge.ask).not.toHaveBeenCalled();
    expect(s.messages).toEqual([original]);
  });

  it("refuses an unreadable rewrite scope before deleting the existing conversation tail", async () => {
    const original = { id: "user-1", role: "user", content: "Original", sources: [], createdAt: "", effects: null };
    const s = state({ messages: [original] });
    composer.parsed = { args: "rewritten", refIds: [] };
    bridge.browserPageText.mockRejectedValueOnce(new Error("page unavailable"));
    setTurnScope({
      scope: "page",
      label: "this page",
      available: ["page"],
      placeholder: "Ask this page",
      sendsPageText: true,
      preamble: "",
      fileIds: ["page-file"],
    } as never);

    await makeChatActions(s as never, vi.fn(), deps()).editAndResend("user-1", "rewritten");

    expect(s.pushToast).toHaveBeenCalledExactlyOnceWith(
      "error",
      "The page couldn't be read, so nothing was asked: Error: page unavailable",
    );
    expect(bridge.deleteMessage).not.toHaveBeenCalled();
    expect(bridge.ask).not.toHaveBeenCalled();
    expect(s.messages).toEqual([original]);
  });

  it.each([
    ["an empty replacement", "user-1", "   "],
    ["a stale message id", "missing-user", "rewritten"],
  ])("leaves history untouched for %s", async (_kind, messageId, replacement) => {
    const original = { id: "user-1", role: "user", content: "Original", sources: [], createdAt: "", effects: null };
    const s = state({ messages: [original] });

    await makeChatActions(s as never, vi.fn(), deps()).editAndResend(messageId, replacement);

    expect(composer.parseComposer).not.toHaveBeenCalled();
    expect(bridge.deleteMessage).not.toHaveBeenCalled();
    expect(bridge.getMessages).not.toHaveBeenCalled();
    expect(bridge.ask).not.toHaveBeenCalled();
    expect(s.messages).toEqual([original]);
  });

  it("retries the last question with privacy bypass and every fabricated evidence source", async () => {
    const original = {
      id: "user-1",
      role: "user",
      content: "Explain the private drawing",
      sources: [],
      createdAt: "",
      effects: null,
    };
    const s = state({
      attachments: [{ id: "pinned" }, { id: "mentioned" }],
      messages: [original],
      openFileRef: { current: { content: { name: "Sketch.canvas" } } },
    });
    const actions = makeChatActions(s as never, vi.fn(), deps());
    composer.parsed = { args: "", refIds: ["mentioned", "parsed"] };
    setTurnScope({
      scope: "room",
      label: "this room",
      available: ["room"],
      placeholder: "Ask this room",
      sendsPageText: false,
      preamble: "",
      fileIds: ["scope", "parsed"],
    });

    await actions.askAgainWithRealDetails();

    expect(composer.parseComposer).toHaveBeenCalledWith(
      original.content,
      s.commands,
      s.skills,
      s.files,
      s.folders,
    );
    expect(bridge.ask).toHaveBeenCalledWith(
      "chat-1",
      original.content,
      ["pinned", "mentioned", "parsed", "scope"],
      expect.any(String),
      "Sketch.canvas",
      true,
    );
    const optimisticUpdate = s.setMessages.mock.calls[0]?.[0] as ((messages: unknown[]) => unknown[]) | undefined;
    expect(optimisticUpdate?.([original])).toEqual([
      original,
      expect.objectContaining({ role: "user", content: original.content, sources: [] }),
    ]);
  });

  it("does not retry while another ask is active", async () => {
    const s = state({
      asking: true,
      messages: [{ id: "user-1", role: "user", content: "Original", sources: [], createdAt: "", effects: null }],
    });

    await makeChatActions(s as never, vi.fn(), deps()).askAgainWithRealDetails();

    expect(s.setMessages).not.toHaveBeenCalled();
    expect(bridge.ask).not.toHaveBeenCalled();
  });

  it("does not retry when the transcript has no user question", async () => {
    const s = state({
      messages: [{ id: "assistant-1", role: "assistant", content: "No question", sources: [], createdAt: "", effects: null }],
    });

    await makeChatActions(s as never, vi.fn(), deps()).askAgainWithRealDetails();

    expect(s.setMessages).not.toHaveBeenCalled();
    expect(bridge.ask).not.toHaveBeenCalled();
  });

  it("reports a fabricated ask failure and refreshes AI state after the retry", async () => {
    const s = state({
      messages: [{ id: "user-1", role: "user", content: "Retry safely", sources: [], createdAt: "", effects: null }],
    });
    const localDeps = deps();
    bridge.ask.mockRejectedValueOnce(new Error("fabricated engine refusal"));

    await makeChatActions(s as never, vi.fn(), localDeps).askAgainWithRealDetails();

    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: fabricated engine refusal");
    expect(localDeps.refreshAi).toHaveBeenCalledOnce();
  });

  it("finalizes an assistant turn without making memory delivery part of the send", async () => {
    const s = state({ question: "#minutes" });
    const actions = makeChatActions(s as never, vi.fn(), deps());
    composer.parsed = { command: "minutes", args: "", refIds: [] };
    bridge.getMessages.mockResolvedValue([
      { id: "assistant-1", role: "assistant", content: "A useful fact", sources: [], createdAt: "", effects: null },
    ]);
    bridge.memorySuggestion.mockResolvedValue({ worth: true, fact: "Useful fact" });
    await actions.send();
    await Promise.resolve();
    expect(s.setMemSuggestion).toHaveBeenCalledWith({ fact: "Useful fact" });
    expect(s.endRun).toHaveBeenCalledWith("chat-1");

    s.question = "#minutes";
    s.memAutoSaveRef.current = true;
    bridge.memorySuggestion.mockResolvedValue({ worth: true, fact: "Saved fact" });
    await actions.send();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.addMemory).toHaveBeenCalledWith("Saved fact");
  });

  it("regenerates from the preceding user message and reloads after a delete failure", async () => {
    const s = state({
      attachments: [{ id: "pinned" }],
      messages: [
        { id: "user-1", role: "user", content: "Original question", sources: [], createdAt: "", effects: null },
        { id: "assistant-1", role: "assistant", content: "Original reply", sources: [], createdAt: "", effects: null },
      ],
    });
    const actions = makeChatActions(s as never, vi.fn(), deps());
    composer.parsed = { args: "Original question", refIds: ["mentioned"] };
    setTurnScope({
      scope: "room",
      label: "this room",
      available: ["room"],
      placeholder: "Ask this room",
      sendsPageText: false,
      preamble: "",
      fileIds: ["scope-file"],
    });
    await actions.regenerate("assistant-1");
    expect(bridge.deleteMessage.mock.calls.slice(0, 2)).toEqual([["assistant-1"], ["user-1"]]);
    expect(bridge.ask).toHaveBeenCalledWith(
      "chat-1",
      "Original question",
      ["pinned", "mentioned", "scope-file"],
      expect.any(String),
      null,
      undefined,
    );

    s.messages = [
      { id: "user-2", role: "user", content: "Retry", sources: [], createdAt: "", effects: null },
      { id: "assistant-2", role: "assistant", content: "Reply", sources: [], createdAt: "", effects: null },
    ];
    bridge.deleteMessage.mockRejectedValueOnce(new Error("locked"));
    await actions.regenerate("assistant-2");
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: locked");
    expect(bridge.ask).toHaveBeenCalledTimes(1);
  });

  it("reloads after a failed edit deletion without sending a replacement turn", async () => {
    const s = state({
      messages: [{ id: "user-1", role: "user", content: "old", sources: [], createdAt: "", effects: null }],
    });
    const actions = makeChatActions(s as never, vi.fn(), deps());
    composer.parsed = { args: "rewritten", refIds: [] };
    bridge.deleteMessage.mockRejectedValueOnce(new Error("locked"));
    await actions.editAndResend("user-1", "rewritten");
    expect(bridge.getMessages).toHaveBeenCalledWith("chat-1");
    expect(s.pushToast).toHaveBeenCalledWith("error", "Couldn't rewrite this message: Error: locked");
    expect(bridge.ask).not.toHaveBeenCalled();
  });

  it("builds each autocomplete menu from the current fabricated room state", () => {
    const s = state();
    const actions = makeChatActions(s as never, vi.fn(), deps());
    expect(actions.autocompleteItems()).toEqual([]);

    s.ac = { kind: "agent", query: "w", start: 0, index: 0 };
    s.specialists = [{ id: "writer" }];
    const agents = [{ key: "writer", label: "Writer", hint: "Writes", insert: "*writer " }];
    composer.specialistItems.mockReturnValue(agents);
    expect(actions.autocompleteItems()).toBe(agents);
    expect(composer.specialistItems).toHaveBeenCalledWith(s.specialists, "w");

    s.ac = { kind: "cmd", query: "min", start: 0, index: 0 };
    s.commands = [
      { name: "minutes", summary: "Make minutes", usage: "#minutes" },
      { name: "outline", summary: "Make an outline", usage: "#outline" },
    ];
    expect(actions.autocompleteItems()).toEqual([
      {
        key: "minutes",
        label: "#minutes",
        hint: "Make minutes",
        insert: "#minutes ",
        usage: "#minutes",
      },
    ]);

    s.ac = { kind: "skill", query: "s", start: 0, index: 0 };
    s.skills = [
      ...Array.from({ length: 11 }, (_unused, index) => ({
        id: `skill-${index}`,
        name: `skill${index}`,
        description: `Skill ${index}`,
        enabled: true,
      })),
      { id: "disabled", name: "skipped", description: "Disabled", enabled: false },
    ];
    const skills = actions.autocompleteItems();
    expect(skills).toHaveLength(10);
    expect(skills[0]).toMatchObject({ key: "skill-skill-0", label: "/skill0" });
    expect(skills.some((item) => item.label === "/skipped")).toBe(false);

    s.ac = { kind: "ref", query: "map", start: 0, index: 0 };
    s.folders = [
      { id: "folder-1", name: "Maps" },
      { id: "folder-2", name: "Roadmaps" },
    ];
    s.files = Array.from({ length: 9 }, (_unused, index) => ({
      id: `file-${index}`,
      name: `map-${index}.md`,
      mimeType: "text/markdown",
    }));
    const references = actions.autocompleteItems();
    expect(references).toHaveLength(10);
    expect(references.slice(0, 2).map((item) => item.label)).toEqual([
      "@Maps/",
      "@Roadmaps/",
    ]);
    expect(references.filter((item) => item.key.startsWith("fi-"))).toHaveLength(8);
  });

  it("shows agent autocomplete notes only for the current fabricated agent menu", () => {
    const s = state();
    const actions = makeChatActions(s as never, vi.fn(), deps());

    expect(actions.autocompleteNote()).toBe("");
    s.ac = { kind: "cmd", query: "help", start: 0, index: 0 };
    expect(actions.autocompleteNote()).toBe("");

    s.ac = { kind: "agent", query: "writer", start: 0, index: 0 };
    s.specialists = null;
    s.specialistsError = "";
    expect(actions.autocompleteNote()).toBe("Looking up this room's specialists…");

    s.specialists = [];
    expect(actions.autocompleteNote()).toBe("This room has no specialists to hand a turn to right now.");

    s.specialists = [{ key: "writer" }];
    expect(actions.autocompleteNote()).toBe("");
    expect(composer.specialistNote).toHaveBeenLastCalledWith(s.specialists, "", "writer");

    s.specialistsError = "fake stale lookup failure";
    s.ac = null;
    expect(actions.autocompleteNote()).toBe("");
  });

  it("loads fabricated specialists once on agent-menu entry and accepts the selected row", async () => {
    const s = state({
      question: "*w",
      composerRef: { current: { selectionStart: 2, focus: vi.fn(), setSelectionRange: vi.fn() } },
    });
    const actions = makeChatActions(s as never, vi.fn(), deps());
    const roster = [{ key: "writer", label: "Writer" }];
    bridge.listSpecialists.mockResolvedValue(roster);
    composer.tokenAtCaret.mockReturnValue({ kind: "agent", query: "w", start: 0 });
    composer.specialistItems.mockReturnValue([
      { key: "ag-writer", label: "*writer", hint: "Writing", insert: "*writer " },
    ]);

    actions.refreshAutocomplete("*w", 2);
    actions.refreshAutocomplete("*wr", 3);
    await Promise.resolve();
    await Promise.resolve();

    expect(bridge.listSpecialists).toHaveBeenCalledOnce();
    expect(s.specialists).toBe(roster);
    expect(s.specialistsError).toBe("");
    expect(actions.autocompleteItems()).toEqual([
      { key: "ag-writer", label: "*writer", hint: "Writing", insert: "*writer " },
    ]);

    actions.acceptAutocomplete("*writer ");
    expect(s.question).toBe("*writer ");
    expect(s.ac).toBeNull();
  });

  it("cancels the active fabricated turn and names only additional stopped work", async () => {
    const s = state({ runIdOf: vi.fn(() => "run-active") });
    bridge.cancelAsk.mockResolvedValueOnce({ stopped: ["answer", "studio build", "file pass"] });

    makeChatActions(s as never, vi.fn(), deps()).stopAsk();
    await Promise.resolve();
    await Promise.resolve();

    expect(voiceMocks.cancelAll).toHaveBeenCalledOnce();
    expect(s.setSpeakingMsgId).toHaveBeenCalledWith(null);
    expect(bridge.cancelAsk).toHaveBeenCalledWith("run-active");
    expect(s.pushToast).toHaveBeenCalledWith("info", "Stopped studio build, file pass too.");

    bridge.cancelAsk.mockResolvedValueOnce({ stopped: ["answer"] });
    makeChatActions(s as never, vi.fn(), deps()).stopAsk();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.pushToast).toHaveBeenCalledTimes(1);

    bridge.cancelAsk.mockRejectedValueOnce(new Error("fabricated cancel race"));
    makeChatActions(s as never, vi.fn(), deps()).stopAsk();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.pushToast).toHaveBeenCalledTimes(1);

    const noActiveRun = state({ runIdOf: vi.fn(() => null) });
    makeChatActions(noActiveRun as never, vi.fn(), deps()).stopAsk();
    expect(noActiveRun.setSpeakingMsgId).toHaveBeenCalledWith(null);
    expect(bridge.cancelAsk).toHaveBeenCalledTimes(3);
  });

  it("replaces a stale specialist roster with the fabricated lookup error", async () => {
    const s = state({
      ac: { kind: "agent", query: "writer", start: 0, index: 0 },
      specialists: [{ key: "old-writer" }],
      specialistsError: "",
    });
    bridge.listSpecialists.mockRejectedValue(new Error("fake specialist lookup failure"));

    await makeChatActions(s as never, vi.fn(), deps()).refreshSpecialists();

    expect(s.specialists).toBeNull();
    expect(s.specialistsError).toBe("Error: fake specialist lookup failure");
    expect(makeChatActions(s as never, vi.fn(), deps()).autocompleteNote())
      .toBe("The specialists couldn't be loaded: Error: fake specialist lookup failure");
  });

  it("inserts every composer trigger and opens its palette before the fake frame", () => {
    const s = state();
    const actions = makeChatActions(s as never, vi.fn(), deps());

    s.question = "  draft";
    composer.tokenAtCaret.mockReturnValue({ kind: "cmd", query: "draft", start: 0 });
    actions.insertComposerToken("#");
    expect(s.question).toBe("#draft");
    expect(s.ac).toEqual({ kind: "cmd", query: "draft", start: 0, index: 0 });

    s.question = "draft";
    composer.tokenAtCaret.mockReturnValue({ kind: "skill", query: "draft", start: 0 });
    actions.insertComposerToken("/");
    expect(s.question).toBe("/draft");
    expect(s.ac).toEqual({ kind: "skill", query: "draft", start: 0, index: 0 });

    s.question = "draft";
    composer.tokenAtCaret.mockReturnValue({ kind: "agent", query: "draft", start: 0 });
    actions.insertComposerToken("*");
    expect(s.question).toBe("*draft");
    expect(s.ac).toEqual({ kind: "agent", query: "draft", start: 0, index: 0 });

    s.question = "draft";
    composer.tokenAtCaret.mockReturnValue({ kind: "ref", query: "", start: 6 });
    actions.insertComposerToken("@");
    expect(s.question).toBe("draft @");

    s.question = "draft ";
    composer.tokenAtCaret.mockReturnValue({ kind: "ref", query: "", start: 6 });
    actions.insertComposerToken("@");
    expect(s.question).toBe("draft @");
    expect(s.composerRef.current.focus).toHaveBeenCalledTimes(5);
    expect(s.composerRef.current.setSelectionRange).toHaveBeenLastCalledWith(7, 7);
  });

  it("cancels every fabricated run before locking and reports a lock failure", async () => {
    const timeout = vi.fn((done: () => void) => {
      done();
      return 1;
    });
    vi.stubGlobal("window", { setTimeout: timeout });
    const s = state({
      runs: {
        active: { runId: "run-active" },
        other: { runId: "run-other" },
      },
    });
    const localDeps = deps();
    const onLock = vi.fn(async () => undefined);
    bridge.cancelAsk.mockRejectedValueOnce(new Error("already stopped"));

    await makeChatActions(s as never, onLock, localDeps).handleLock();

    expect(voiceMocks.cancelAll).toHaveBeenCalledOnce();
    expect(bridge.cancelAsk).toHaveBeenNthCalledWith(1, "run-active");
    expect(bridge.cancelAsk).toHaveBeenNthCalledWith(2, "run-other");
    expect(timeout).toHaveBeenCalledWith(expect.any(Function), 250);
    expect(localDeps.playSealSound).toHaveBeenCalledOnce();
    expect(onLock).toHaveBeenCalledOnce();

    room.prefersReducedMotion.mockReturnValue(true);
    const refusingLock = vi.fn(async () => {
      throw new Error("still open");
    });
    const motionDeps = deps();
    const failedState = state();
    await makeChatActions(failedState as never, refusingLock, motionDeps).handleLock();
    expect(motionDeps.playSealSound).not.toHaveBeenCalled();
    expect(refusingLock).toHaveBeenCalledOnce();
    expect(failedState.pushToast).toHaveBeenCalledWith(
      "error",
      "Couldn't lock the room — it's still open. Try again.",
    );
  });

  it("imports only pasted images and preserves attachment and error behavior", async () => {
    const s = state({ attachments: [{ id: "existing" }] });
    const actions = makeChatActions(s as never, vi.fn(), deps());
    const preventDefault = vi.fn();

    await actions.onComposerPaste({ clipboardData: undefined, preventDefault } as never);
    await actions.onComposerPaste({
      clipboardData: { items: [{ type: "text/plain" }] },
      preventDefault,
    } as never);
    await actions.onComposerPaste({
      clipboardData: { items: [{ type: "image/png", getAsFile: () => null }] },
      preventDefault,
    } as never);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(bridge.importImageBytes).not.toHaveBeenCalled();

    const image = { name: "clipboard.png" } as File;
    composer.fileToBase64.mockResolvedValueOnce("encoded-image");
    bridge.importImageBytes.mockResolvedValueOnce({ id: "pasted-image" });
    bridge.listFiles.mockResolvedValueOnce([{ id: "pasted-image" }]);
    await actions.onComposerPaste({
      clipboardData: { items: [{ type: "image/png", getAsFile: () => image }] },
      preventDefault,
    } as never);
    expect(bridge.importImageBytes).toHaveBeenCalledWith(
      expect.stringMatching(/^Pasted image .+\.png$/),
      "encoded-image",
    );
    expect(s.attachments).toEqual([{ id: "existing" }, { id: "pasted-image" }]);

    composer.fileToBase64.mockResolvedValueOnce("encoded-again");
    bridge.importImageBytes.mockResolvedValueOnce({ id: "pasted-image" });
    bridge.listFiles.mockResolvedValueOnce([{ id: "pasted-image" }]);
    await actions.onComposerPaste({
      clipboardData: { items: [{ type: "image/png", getAsFile: () => image }] },
      preventDefault,
    } as never);
    expect(s.attachments).toEqual([{ id: "existing" }, { id: "pasted-image" }]);

    composer.fileToBase64.mockRejectedValueOnce(new Error("unreadable image"));
    await actions.onComposerPaste({
      clipboardData: { items: [{ type: "image/png", getAsFile: () => image }] },
      preventDefault,
    } as never);
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: unreadable image");
  });

  it("refuses unreadable page scopes instead of silently asking the whole room", async () => {
    const s = state({ question: "What changed?" });
    const actions = makeChatActions(s as never, vi.fn(), deps());
    setTurnScope({
      scope: "page",
      label: "this page",
      available: ["page"],
      placeholder: "Ask this page",
      sendsPageText: true,
      preamble: "",
      fileIds: ["page-file"],
    } as never);

    await actions.send();
    expect(bridge.browserPageText).toHaveBeenCalledWith("main", 0);
    expect(bridge.ask).toHaveBeenCalledWith(
      "chat-1",
      "[Page] What changed?",
      ["page-file"],
      expect.any(String),
      null,
      undefined,
    );

    s.question = "Why blocked?";
    bridge.browserPageText.mockRejectedValueOnce(new Error("blocked"));
    await actions.send();
    expect(s.pushToast).toHaveBeenCalledWith(
      "error",
      "The page couldn't be read, so nothing was asked: Error: blocked",
    );

    s.question = "What is here?";
    bridge.browserPageText.mockResolvedValueOnce({ title: "Empty", url: "https://example.test", text: "" });
    await actions.send();
    expect(s.pushToast).toHaveBeenCalledWith(
      "error",
      "This page returned no text — it may be a PDF, a canvas or a video. Nothing was asked.",
    );

    setTurnScope({
      scope: "selection",
      label: "this selection",
      available: ["selection"],
      placeholder: "Ask this selection",
      sendsPageText: true,
      preamble: "",
      fileIds: [],
    } as never);
    s.question = "What is selected?";
    bridge.browserPageSelection.mockResolvedValueOnce({ title: "Page", url: "https://example.test", text: "  ", total: 2 });
    await actions.send();
    expect(s.pushToast).toHaveBeenCalledWith(
      "error",
      "Nothing is selected on the page any more, so nothing was asked.",
    );

    s.question = "Read my selection";
    bridge.browserPageSelection.mockRejectedValueOnce(new Error("selection bridge unavailable"));
    await actions.send();
    expect(s.pushToast).toHaveBeenCalledWith(
      "error",
      "The selection couldn't be read, so nothing was asked: Error: selection bridge unavailable",
    );

    s.question = "Explain this";
    bridge.browserPageSelection.mockResolvedValueOnce({
      title: "Selected page",
      url: "https://example.test/selected",
      text: "chosen passage",
      total: 30,
    });
    await actions.send();
    expect(browserScope.withSelectionContext).toHaveBeenCalledWith("Explain this", {
      title: "Selected page",
      url: "https://example.test/selected",
      text: "chosen passage",
      omitted: 16,
    });

    setTurnScope({
      scope: "room",
      label: "this room",
      available: ["room"],
      placeholder: "Ask this room",
      sendsPageText: true,
      preamble: "",
      fileIds: [],
    } as never);
    s.question = "Why unavailable?";
    await actions.send();
    expect(s.pushToast).toHaveBeenCalledWith(
      "error",
      "This room can't read this room yet, so nothing was asked.",
    );
  });

  it("saves the matching answer under a unique name and leaves a failed draft intact", async () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      content: "A durable answer",
      sources: [],
      createdAt: "",
      effects: null,
    };
    const s = state({
      files: [{ id: "existing", name: "AI note.md" }],
      saveDraft: { id: "assistant-1", name: "  " },
    });
    const actions = makeChatActions(s as never, vi.fn(), deps());

    await actions.saveToRoom({ ...message, id: "other" });
    expect(bridge.saveGeneratedFile).not.toHaveBeenCalled();

    composer.uniqueFileName.mockReturnValueOnce("AI note 2.md");
    bridge.saveGeneratedFile.mockResolvedValueOnce({ id: "saved", name: "AI note 2.md" });
    bridge.listFiles.mockResolvedValueOnce([{ id: "saved", name: "AI note 2.md" }]);
    await actions.saveToRoom(message as never);
    expect(composer.uniqueFileName).toHaveBeenCalledWith("AI note.md", ["AI note.md"]);
    expect(bridge.saveGeneratedFile).toHaveBeenCalledWith("AI note 2.md", "A durable answer");
    expect(s.saveDraft).toBeNull();
    expect(s.pushToast).toHaveBeenCalledWith("success", 'Saved "AI note 2.md" into the room.');

    s.saveDraft = { id: "assistant-1", name: "Retry.md" };
    bridge.saveGeneratedFile.mockRejectedValueOnce(new Error("fake disk full"));
    await actions.saveToRoom(message as never);
    expect(s.saveDraft).toEqual({ id: "assistant-1", name: "Retry.md" });
    expect(s.pushToast).toHaveBeenCalledWith(
      "error",
      "Couldn't save this answer: Error: fake disk full",
    );
  });

  it("replaces the last removed chat with a fake empty conversation", async () => {
    const s = state({ activeChatId: "removed" });
    const actions = makeChatActions(s as never, vi.fn(), deps());
    const replacement = { id: "replacement" };
    bridge.listChats.mockResolvedValueOnce([]);
    bridge.createChat.mockResolvedValueOnce(replacement);

    await actions.removeChat("removed");

    expect(bridge.deleteChat).toHaveBeenCalledWith("removed");
    expect(bridge.listChats).toHaveBeenCalledOnce();
    expect(bridge.createChat).toHaveBeenCalledOnce();
    expect(s.setChats).toHaveBeenCalledWith([replacement]);
    expect(s.setActiveChatId).toHaveBeenCalledWith("replacement");
  });

  it("keeps or moves the selected chat after fake removal and reports failures", async () => {
    const remaining = [{ id: "first" }, { id: "second" }];
    const selected = state({ activeChatId: "removed" });
    bridge.listChats.mockResolvedValueOnce(remaining);
    await makeChatActions(selected as never, vi.fn(), deps()).removeChat("removed");
    expect(selected.setChats).toHaveBeenCalledWith(remaining);
    expect(selected.setActiveChatId).toHaveBeenCalledWith("first");

    const otherSelected = state({ activeChatId: "second" });
    bridge.listChats.mockResolvedValueOnce(remaining);
    await makeChatActions(otherSelected as never, vi.fn(), deps()).removeChat("removed");
    expect(otherSelected.setChats).toHaveBeenCalledWith(remaining);
    expect(otherSelected.setActiveChatId).not.toHaveBeenCalled();

    const failed = state();
    bridge.deleteChat.mockRejectedValueOnce(new Error("fake refusal"));
    await makeChatActions(failed as never, vi.fn(), deps()).removeChat("removed");
    expect(failed.pushToast).toHaveBeenCalledWith(
      "error",
      "Couldn't delete this chat: Error: fake refusal",
    );
  });

  it("hands off a chat through fake IPC and applies the returned usage", async () => {
    const s = state();
    const marker = { effects: { usage: { contextTokens: 12 } } };
    const messages = [{ id: "handoff", role: "assistant", content: "Summary", sources: [], createdAt: "", effects: null }];
    bridge.handoffContext.mockResolvedValueOnce(marker);
    bridge.getMessages.mockResolvedValueOnce(messages);

    await makeChatActions(s as never, vi.fn(), deps()).handoffContext();

    expect(s.setHandoffStarting.mock.calls).toEqual([[true], [false]]);
    expect(bridge.handoffContext).toHaveBeenCalledWith("chat-1");
    expect(bridge.getMessages).toHaveBeenCalledWith("chat-1");
    expect(s.messages).toEqual(messages);
    expect(s.setChatUsage).toHaveBeenCalledWith("chat-1", marker.effects.usage);
  });

  it("does not start a handoff when the fake workspace is not ready", async () => {
    const unavailable = [
      state({ activeChatId: null }),
      state({ asking: true }),
      state({ handoffStarting: true }),
    ];

    for (const s of unavailable) await makeChatActions(s as never, vi.fn(), deps()).handoffContext();

    expect(bridge.handoffContext).not.toHaveBeenCalled();
    expect(bridge.getMessages).not.toHaveBeenCalled();
  });

  it("creates optimistic minutes through a fake command turn", async () => {
    const s = state({ openFile: { id: "notes", content: { name: "Meeting notes.md" } } });
    const savedMessages = [{ id: "assistant", role: "assistant", content: "Minutes", sources: [], createdAt: "", effects: null }];
    bridge.getMessages.mockResolvedValueOnce(savedMessages);

    await makeChatActions(s as never, vi.fn(), deps()).makeMinutes();

    const optimistic = s.setMessages.mock.calls[0][0]([])[0];
    expect(optimistic).toMatchObject({
      id: expect.stringMatching(/^pending-/),
      role: "user",
      content: "#minutes @Meeting notes.md",
      sources: [],
      effects: null,
    });
    expect(bridge.runCommand).toHaveBeenCalledWith(
      "chat-1",
      "minutes",
      "",
      ["notes"],
      "#minutes @Meeting notes.md",
      expect.any(String),
    );
    expect(s.messages).toEqual(savedMessages);
  });

  it("does not create minutes while fake file or chat prerequisites are unavailable", async () => {
    const unavailable = [
      state(),
      state({ asking: true, openFile: { id: "notes", content: { name: "Meeting.md" } } }),
      state({ activeChatId: null, openFile: { id: "notes", content: { name: "Meeting.md" } } }),
    ];

    for (const s of unavailable) await makeChatActions(s as never, vi.fn(), deps()).makeMinutes();

    expect(bridge.runCommand).not.toHaveBeenCalled();
    for (const s of unavailable) expect(s.setMessages).not.toHaveBeenCalled();
  });

  it("starts a fabricated chat and leaves the current one intact when creation fails", async () => {
    const s = state();
    const created = { id: "chat-created", title: "Fresh chat" };
    const refreshed = [created, { id: "chat-1", title: "Older chat" }];
    bridge.createChat.mockResolvedValueOnce(created);
    bridge.listChats.mockResolvedValueOnce(refreshed);

    await makeChatActions(s as never, vi.fn(), deps()).newChat();

    expect(bridge.createChat).toHaveBeenCalledOnce();
    expect(s.setChats).toHaveBeenCalledWith(refreshed);
    expect(s.setActiveChatId).toHaveBeenCalledWith("chat-created");

    const failed = state({ activeChatId: "chat-existing" });
    bridge.createChat.mockRejectedValueOnce(new Error("fake create refusal"));
    await makeChatActions(failed as never, vi.fn(), deps()).newChat();
    expect(failed.activeChatId).toBe("chat-existing");
    expect(failed.pushToast).toHaveBeenCalledWith(
      "error",
      "Couldn't start a new chat: Error: fake create refusal",
    );
  });

  it("runs fabricated copy, source, rename, and attachment controls without external services", async () => {
    const newest = { id: "newest", name: "report.md", createdAt: "2026-02-01T00:00:00Z" };
    const older = { id: "older", name: "report.md", createdAt: "2026-01-01T00:00:00Z" };
    const attached = { id: "attachment", name: "brief.md", createdAt: "2026-01-03T00:00:00Z" };
    const s = state({
      chats: [{ id: "chat-1", title: "Current title" }],
      files: [older, newest, attached],
    });
    const d = deps();
    const actions = makeChatActions(s as never, vi.fn(), d);

    actions.copyMessage({
      id: "assistant-1",
      role: "assistant",
      content: "A copied answer",
      sources: [],
      createdAt: "",
      effects: null,
    } as never);
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("A copied answer");
    expect(s.pushToast).toHaveBeenCalledWith("success", "Copied to clipboard.");

    actions.openSource("report.md");
    expect(d.viewFile).toHaveBeenCalledWith("newest");
    actions.openSource("missing.md");
    expect(s.pushToast).toHaveBeenCalledWith("info", "That file is no longer in the room.");

    actions.startRename();
    expect(s.renameDraft).toBe("Current title");
    expect(s.renaming).toBe(true);

    actions.toggleAttach(attached as never);
    expect(s.attachments).toEqual([attached]);
    actions.toggleAttach(attached as never);
    expect(s.attachments).toEqual([]);
  });

  it("notifies scope subscribers only while their fabricated subscription is active", () => {
    const notify = vi.fn();
    const unsubscribe = subscribeTurnScope(notify);
    const current = currentTurnScope();

    setTurnScope(current);
    expect(notify).not.toHaveBeenCalled();

    const changed = { ...current, scope: "page", label: "this page" };
    setTurnScope(changed as never);
    expect(notify).toHaveBeenCalledOnce();

    unsubscribe();
    setTurnScope({ ...changed, label: "another page" } as never);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("runs fabricated memory and model-recovery toast actions", async () => {
    const s = state({ question: "#minutes", memAutoSaveRef: { current: true } });
    const localDeps = deps();
    composer.parsed = { command: "minutes", args: "", refIds: [] };
    bridge.getMessages.mockResolvedValue([
      { id: "assistant-1", role: "assistant", content: "Finished answer", sources: [], createdAt: "", effects: null },
    ]);
    bridge.memorySuggestion.mockResolvedValue({ worth: true, fact: "A saved fact" });
    bridge.addMemory.mockResolvedValue({ id: "memory-1", createdAt: new Date().toISOString() });
    bridge.listMemories.mockResolvedValue([{ id: "memory-1", fact: "A saved fact" }]);
    const actions = makeChatActions(s as never, vi.fn(), localDeps);

    await actions.send();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    const memoryToast = s.pushToast.mock.calls.find(
      (call: unknown[]) => call[1] === "Remembered: A saved fact",
    )?.[2] as { run?: () => void } | undefined;
    memoryToast?.run?.();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(bridge.deleteMemory).toHaveBeenCalledWith("memory-1");
    expect(s.setMemories).toHaveBeenLastCalledWith([{ id: "memory-1", fact: "A saved fact" }]);

    bridge.ask.mockRejectedValueOnce(new Error("MODEL_MISSING"));
    await actions.askOnce("Need the fake model", []);
    const modelToast = s.pushToast.mock.calls.find(
      (call: unknown[]) => call[1] === 'Model "model" is not downloaded yet.',
    )?.[2] as { run?: () => Promise<void> } | undefined;
    await modelToast?.run?.();
    expect(localDeps.downloadModel).toHaveBeenCalledWith("model");
  });

  it("copies the fabricated previous reply from regenerate's recovery toast", async () => {
    const s = state({
      messages: [
        { id: "user-1", role: "user", content: "Try again", sources: [], createdAt: "", effects: null },
        { id: "assistant-1", role: "assistant", content: "Previous answer", sources: [], createdAt: "", effects: null },
      ],
    });
    composer.parsed = { args: "Try again", refIds: [] };
    await makeChatActions(s as never, vi.fn(), deps()).regenerate("assistant-1");

    const copyToast = s.pushToast.mock.calls.find(
      (call: unknown[]) => call[1] === "Asking again — the previous answer was deleted.",
    )?.[2] as { run?: () => void } | undefined;
    copyToast?.run?.();
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Previous answer");
    expect(s.pushToast).toHaveBeenCalledWith(
      "success",
      "The previous answer was copied to the clipboard.",
    );
  });

  it("keeps finished-turn cleanup reliable across reload, approval, and memory failures", async () => {
    const approvals = [{ id: "approval-1" }];
    const s = state({
      editedRef: { current: new Set(["edited-file"]) },
      memAutoSaveRef: { current: true },
      question: "#minutes",
      setEditApprovals: vi.fn((update) => update(approvals)),
    });
    composer.parsed = { command: "minutes", args: "", refIds: [] };
    bridge.getMessages.mockResolvedValueOnce([
      { id: "assistant-1", role: "assistant", content: "Finished", sources: [], createdAt: "", effects: null },
    ]);
    bridge.resolveEditApproval.mockRejectedValueOnce(new Error("approval channel closed"));
    bridge.memorySuggestion.mockResolvedValueOnce({ worth: true, fact: "A fact that cannot be saved" });
    bridge.addMemory.mockRejectedValueOnce(new Error("memory store unavailable"));
    const actions = makeChatActions(s as never, vi.fn(), deps());
    bridge.runCommand.mockImplementationOnce(async () => {
      s.editedRef.current.add("edited-file");
    });

    await actions.send();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    expect(s.setUndoByMsg).toHaveBeenCalledWith(expect.any(Function));
    const updateUndo = s.setUndoByMsg.mock.calls[0]?.[0];
    expect(updateUndo({})).toEqual({ "assistant-1": ["edited-file"] });
    expect(bridge.resolveEditApproval).toHaveBeenCalledWith("approval-1", "deny");
    expect(s.endRun).toHaveBeenCalledWith("chat-1");
    expect(s.pushToast).not.toHaveBeenCalledWith("success", expect.stringContaining("Remembered"), expect.anything());

    s.question = "#minutes";
    bridge.getMessages.mockRejectedValueOnce(new Error("chat reload unavailable"));
    await actions.send();
    expect(s.pushToast).toHaveBeenCalledWith(
      "error",
      "The answer finished but this chat couldn't be reloaded: Error: chat reload unavailable",
    );
  });

  it("regenerates command turns and tolerates a failed recovery reload", async () => {
    const s = state({
      messages: [
        { id: "user-command", role: "user", content: "#minutes", sources: [], createdAt: "", effects: null },
        { id: "assistant-command", role: "assistant", content: "Old minutes", sources: [], createdAt: "", effects: null },
      ],
    });
    composer.parsed = { command: "minutes", args: "weekly", refIds: ["notes"] };
    const actions = makeChatActions(s as never, vi.fn(), deps());

    await actions.regenerate("assistant-command");
    expect(bridge.runCommand).toHaveBeenCalledWith(
      "chat-1", "minutes", "weekly", ["notes"], "#minutes", expect.any(String),
    );

    s.messages = [{ id: "assistant-only", role: "assistant", content: "No question", sources: [], createdAt: "", effects: null }];
    await actions.regenerate("assistant-only");
    expect(bridge.deleteMessage).toHaveBeenCalledTimes(2);

    s.messages = [
      { id: "user-fail", role: "user", content: "Retry", sources: [], createdAt: "", effects: null },
      { id: "assistant-fail", role: "assistant", content: "Reply", sources: [], createdAt: "", effects: null },
    ];
    bridge.deleteMessage.mockRejectedValueOnce(new Error("delete locked"));
    bridge.getMessages.mockRejectedValueOnce(new Error("reload locked"));
    await actions.regenerate("assistant-fail");
    expect(s.pushToast).toHaveBeenCalledWith("error", "Error: delete locked");
  });

  it("reports a failed post-edit reload and an OCR result with no words", async () => {
    const s = state({
      messages: [{ id: "user-1", role: "user", content: "Original", sources: [], createdAt: "", effects: null }],
      openFile: { content: { kind: "image", text: "(OCR extracted from image)" } },
    });
    readable.ocr = "";
    const actions = makeChatActions(s as never, vi.fn(), deps());
    actions.copyAllText();
    expect(s.pushToast).toHaveBeenCalledWith("info", "There are no words in this file to copy.");

    composer.parsed = { args: "Rewritten", refIds: [] };
    bridge.getMessages.mockRejectedValueOnce(new Error("reload unavailable"));
    await actions.editAndResend("user-1", "Rewritten");
    expect(s.pushToast).toHaveBeenCalledWith("error", "Couldn't reload this chat: Error: reload unavailable");
    expect(bridge.ask).not.toHaveBeenCalled();
  });
});
