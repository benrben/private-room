import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatPane from "./ChatPane";

const { act, createElement } = React;

const mocks = vi.hoisted(() => ({
  cloud: false,
  ready: true,
  annotated: vi.fn(() => createElement("div", { "data-testid": "annotated" })),
  markdown: vi.fn(({ text }: { text: string }) => createElement("div", { "data-testid": "markdown" }, text)),
  graph: vi.fn(() => createElement("div", { "data-testid": "graph" })),
  handoff: vi.fn(() => createElement("div", { "data-testid": "handoff" })),
  composer: vi.fn(() => createElement("div", { "data-testid": "composer" })),
  delete: vi.fn(({ onConfirm }: { onConfirm: () => void }) => createElement("button", { onClick: onConfirm }, "delete chat")),
  uniqueFileName: vi.fn(() => "AI note 2.md"),
}));

vi.mock("../icons", () => ({
  CheckIcon: () => null, DownloadIcon: () => null, EmptyChatArt: () => null,
  EyeIcon: () => null, HandsFreeIcon: () => null, MemoryIcon: () => null,
  PencilIcon: () => null, PlayIcon: () => null, SparkIcon: () => null,
  SpeakerIcon: () => null, StopIcon: () => null, TrashIcon: () => null,
  UndoIcon: () => null,
}));
vi.mock("../viewers/ChatAnnotatedImage", () => ({ default: mocks.annotated }));
vi.mock("../viewers/MarkdownView", () => ({ default: mocks.markdown }));
vi.mock("./TokenBudgetBar", () => ({ HandoffMarker: mocks.handoff }));
vi.mock("./AgentGraph", () => ({ AgentGraph: mocks.graph }));
vi.mock("./ComposerPane", () => ({ default: mocks.composer }));
vi.mock("./DeleteControl", () => ({ default: mocks.delete }));
vi.mock("./composer", () => ({ uniqueFileName: mocks.uniqueFileName }));
vi.mock("./markup", () => ({
  annotationTarget: (annotation: unknown) => annotation,
  handTokens: (text: string) => [{ text: text.slice(0, 4), mono: false }, { text: text.slice(4), mono: true }],
  isCloudRoute: () => mocks.cloud,
  isHandwritten: (text: string) => text.startsWith("hand"),
  isModelReady: () => mocks.ready,
  lostReplyAdvice: (notice: string) => `Advice: ${notice}`,
  lostReplyNotice: (text: string) => text === "lost" ? "Reply lost" : null,
  messageClock: (createdAt: string) => createdAt ? "now" : null,
  patchStreamFences: (text: string) => `patched:${text}`,
  speakerName: (role: string) => role === "assistant" ? "Arcelle" : "You",
  splitMarkupBlocks: (text: string) => ({ text: `split:${text}`, boxes: undefined, annotation: undefined }),
}));
vi.mock("./constants", () => ({
  CHAT_PAGE: 2,
  chatPageSlice: (messages: unknown[], count: number) => ({ hidden: Math.max(0, messages.length - count), visible: messages.slice(-count) }),
  chatPageToReveal: (length: number, index: number) => length - index,
  HELP_COMMAND: { name: "help", summary: "Help", usage: "#help" },
  RECOMMENDED_MODELS: [
    { name: "small", tag: "Quick", label: "Small", size: "1 GB", blurb: "Fast" },
    { name: "large", tag: null, label: "Large", size: "4 GB", blurb: "Deep" },
  ],
}));

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  navigator: globalThis.navigator,
  HTMLElement: globalThis.HTMLElement,
  HTMLInputElement: globalThis.HTMLInputElement,
  HTMLSelectElement: globalThis.HTMLSelectElement,
  HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
  Event: globalThis.Event,
  React: Reflect.get(globalThis, "React"),
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
};

afterEach(() => {
  vi.clearAllMocks();
  mocks.cloud = false;
  mocks.ready = true;
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

function message(id: string, role: "assistant" | "user", content: string, extra: Record<string, unknown> = {}) {
  return { id, role, content, createdAt: "2026-08-31T10:00:00Z", kind: "message", sources: [], effects: null, ...extra };
}

function state(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    ai: { running: true, installed: true }, model: "local", messages: [],
    activeChatId: "chat-1", chats: [{ id: "chat-1", title: "First" }],
    renaming: false, renameDraft: "First", asking: false, autoSpeak: false, handsFree: false,
    confirmDelete: null, showSyncWarn: false, privacyOn: true, pullingModel: false,
    pullPercent: 25, pullStatus: "Downloading", pullError: "", chatRef: { current: null },
    commands: [], revealMsgId: null, agentPlan: null, activeAgent: null, agentSteps: {},
    agentReports: {}, steps: [], lane: "", streamText: "", askPrivacy: null,
    memSuggestion: null, files: [{ name: "AI note.md" }], speakingMsgId: null,
    undoByMsg: {}, saveDraft: null, webOn: false, mcpTools: [],
    setRenameDraft: vi.fn(), setRenaming: vi.fn(), setActiveChatId: vi.fn(),
    setMemSuggestion: vi.fn(), setRevealMsgId: vi.fn(), setSaveDraft: vi.fn(),
    composerRef: { current: { focus: vi.fn() } }, setQuestion: vi.fn(),
    ...overrides,
  };
}

function actions(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    commitRename: vi.fn(), startRename: vi.fn(), newChat: vi.fn(), copyConversation: vi.fn(),
    toggleAutoSpeak: vi.fn(), toggleHandsFree: vi.fn(), removeChat: vi.fn(), askConfirm: vi.fn(),
    cancelConfirm: vi.fn(), dismissSyncWarn: vi.fn(), getOllama: vi.fn(), refreshAi: vi.fn(),
    openOllamaApp: vi.fn(), stopModelPull: vi.fn(async () => undefined), pickAndDownload: vi.fn(),
    viewFile: vi.fn(), copyReceipt: vi.fn(), copyMessage: vi.fn(), regenerate: vi.fn(),
    speakMessage: vi.fn(), undoEdits: vi.fn(), saveToRoom: vi.fn(), editAndResend: vi.fn(),
    openSource: vi.fn(), askAgainWithRealDetails: vi.fn(async () => undefined),
    saveSuggestedMemory: vi.fn(), enableMemoryAutoSave: vi.fn(),
    ...overrides,
  };
}

async function renderPane(s: Record<string, any>, a = actions()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "HTMLSelectElement", window.HTMLSelectElement);
  Reflect.set(globalThis, "HTMLTextAreaElement", window.HTMLTextAreaElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const draw = async () => act(async () => {
    root.render(createElement(ChatPane, { s: s as never, a: a as never, info: { path: "/tmp/Room" } as never }));
    await Promise.resolve();
  });
  await draw();
  return { a, document, draw, host, root, s, window };
}

async function click(view: Awaited<ReturnType<typeof renderPane>>, label: string) {
  const button = [...view.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));
  await act(async () => button?.dispatchEvent(new view.window.Event("click", { bubbles: true })));
}

async function clickTitle(view: Awaited<ReturnType<typeof renderPane>>, title: string) {
  const button = view.host.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  await act(async () => button?.dispatchEvent(new view.window.Event("click", { bubbles: true })));
}

async function clickSelector(view: Awaited<ReturnType<typeof renderPane>>, selector: string) {
  const button = view.host.querySelector<HTMLButtonElement>(selector);
  await act(async () => button?.dispatchEvent(new view.window.Event("click", { bubbles: true })));
}

function reactProp(element: Element, name: string): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React props missing for ${name}`);
  return (element as unknown as Record<string, Record<string, (event: Record<string, unknown>) => void>>)[key][name];
}

async function change(view: Awaited<ReturnType<typeof renderPane>>, input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  void view;
  await act(async () => reactProp(input, "onChange")({ target: { value } }));
}

async function key(view: Awaited<ReturnType<typeof renderPane>>, input: HTMLElement, keyValue: string) {
  void view;
  await act(async () => reactProp(input, "onKeyDown")({ key: keyValue, preventDefault: vi.fn(), stopPropagation: vi.fn() }));
}

describe("ChatPane", () => {
  it("renders transcript content, receipts, saved effects, and message actions", async () => {
    mocks.cloud = true;
    mocks.ready = false;
    const assistant = message("a-1", "assistant", "answer", {
      sources: ["note.md"],
      effects: {
        boxes: { fileId: "file-1", boxes: [] },
        annotation: { fileId: "file-1", quote: "quoted", approx: false, note: "Note", range: "p.1", name: "note.md" },
        agents: [{ label: "Research", instruction: "Look", status: "failed" }],
        edits: [{ outcome: "applied", files: 2 }],
      },
    });
    const user = message("u-1", "user", "hand @name");
    const lost = message("a-2", "assistant", "lost", { sources: [] });
    const s = state({
      messages: [assistant, user, { ...message("h-1", "assistant", "handoff"), kind: "handoff" }, lost],
      showSyncWarn: true, privacyOn: false, commands: [{ name: "summarize", summary: "Sum", usage: "#summarize" }],
      askPrivacy: { bypassed: false, entities_hidden: 2, images_blocked: 1 },
      memSuggestion: { fact: "Remember this" }, saveDraft: { id: "a-1", name: "note.md" },
      undoByMsg: { "a-1": [{}, {}] }, speakingMsgId: "a-1",
    });
    const view = await renderPane(s);

    expect(view.host.textContent).toContain("Privacy is off");
    expect(view.host.textContent).toContain("Show earlier messages (2 older)");
    const selector = view.host.querySelector<HTMLSelectElement>("select.chat-select");
    if (!selector) throw new Error("chat selector missing");
    await change(view, selector, "chat-1");
    await click(view, "Show earlier messages");
    expect(view.host.textContent).toContain("Made 2 file changes in this room");
    expect(view.host.textContent).toContain("Advice: Reply lost");
    expect(view.host.querySelector('[data-testid="annotated"]')).not.toBeNull();
    expect(view.host.querySelector('[data-testid="handoff"]')).not.toBeNull();
    await click(view, "delete chat");
    await click(view, "Dismiss");
    await click(view, "Download");
    await clickTitle(view, "Show the highlight in the viewer");
    await click(view, "Copy as receipt");
    await clickTitle(view, "Open note.md");
    await clickTitle(view, "Stop speaking");
    await clickTitle(view, "Copy this answer");
    await clickTitle(view, "Undo the file change this answer made (reversible via version history)");
    await clickTitle(view, "Copy this message");
    await click(view, "Try again");
    await click(view, "Regenerate");
    const saveInput = view.host.querySelector<HTMLInputElement>(".save-form input");
    if (!saveInput) throw new Error("save input missing");
    await change(view, saveInput, "changed.md");
    await key(view, saveInput, "Enter");
    await click(view, "Save");
    await click(view, "Cancel");
    await click(view, "Save to room");
    await click(view, "Save to memory");
    await click(view, "Ignore");
    await click(view, "Always save");
    await click(view, "Ask again sharing blocked images");
    expect(view.host.textContent).toContain("Send this question again with the real details and blocked images?");
    await clickSelector(view, ".privacy-valve-confirm button:not(.danger)");
    await click(view, "Ask again sharing blocked images");
    await click(view, "Yes, this once");
    expect(view.a.askAgainWithRealDetails).toHaveBeenCalled();
    expect(view.a.copyReceipt).toHaveBeenCalled();
    expect(view.a.regenerate).toHaveBeenCalledWith("a-2");
    await act(async () => view.root.unmount());
  });

  it("supports the empty, rename, and each local-AI onboarding state", async () => {
    const s = state({
      ai: { running: false, installed: false }, renaming: true, messages: [],
      commands: [{ name: "find", summary: "Find", usage: "#find" }],
    });
    const view = await renderPane(s);
    expect(view.host.textContent).toContain("Get Ollama");
    expect(view.host.textContent).toContain("Ask your room");
    const input = view.host.querySelector<HTMLInputElement>(".chat-rename");
    if (!input) throw new Error("rename input missing");
    await change(view, input, "Renamed");
    await key(view, input, "Enter");
    expect(view.a.commitRename).toHaveBeenCalled();
    await click(view, "Get Ollama");
    await click(view, "Summarize what's in this room");
    await click(view, "#find");
    expect(s.setQuestion).toHaveBeenCalledWith("#find ");

    Object.assign(s, { ai: { running: false, installed: true }, renaming: false });
    await view.draw();
    expect(view.host.textContent).toContain("installed but not running");
    await click(view, "Open Ollama");

    Object.assign(s, { ai: { running: true, installed: true }, pullingModel: true, pullError: "network" });
    mocks.ready = false;
    await view.draw();
    expect(view.host.textContent).toContain("Downloading");
    expect(view.host.textContent).toContain("network");
    await click(view, "Stop");
    expect(view.a.stopModelPull).toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });

  it("preserves streaming route, step, graph, reveal, and edit/resend behavior", async () => {
    const old = message("old", "user", "old");
    const user = message("user", "user", "question");
    const s = state({
      messages: [old, user], asking: true, streamText: "", webOn: true, mcpTools: ["tool"],
      revealMsgId: "old", agentPlan: [{ label: "Plan", instruction: "Do", status: "done" }, { label: "Help", instruction: "Also", status: "done" }],
      steps: Array.from({ length: 7 }, (_, index) => ({ label: `Step ${index}`, ok: index !== 2 })), lane: "research",
    });
    const view = await renderPane(s);
    expect(view.host.textContent).toContain("Thinking on this Mac");
    expect(view.host.textContent).toContain("+1 earlier");
    expect(s.setRevealMsgId).toHaveBeenCalledWith(null);
    Object.assign(s, { asking: false });
    await view.draw();
    await click(view, "Edit & resend");
    const textarea = view.host.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    if (!textarea) throw new Error("textarea missing");
    await change(view, textarea, "edited");
    await key(view, textarea, "Escape");
    await click(view, "Edit & resend");
    await click(view, "Send again");
    expect(view.a.editAndResend).toHaveBeenCalledWith("old", "old");

    Object.assign(s, { asking: true, streamText: "partial" });
    await view.draw();
    expect(view.host.textContent).toContain("patched:partial");
    mocks.cloud = true;
    Object.assign(s, { streamText: "" });
    await view.draw();
    expect(view.host.textContent).toContain("Asking your cloud AI");

    Object.assign(s, { agentPlan: [{ label: "Plan", instruction: "Do", status: "done" }, { label: "Help", instruction: "Also", status: "done" }] });
    await view.draw();
    Object.assign(s, { asking: false, messages: [...s.messages, message("answer", "assistant", "done")], agentPlan: null });
    await view.draw();
    expect(view.host.textContent).toContain("The answer is ready.");
    Object.assign(s, { askPrivacy: { bypassed: false, entities_hidden: 0, images_blocked: 1 } });
    await view.draw();
    await click(view, "Ask again sharing blocked images");
    expect(view.host.textContent).toContain("Send this question again with the blocked images?");
    await clickSelector(view, ".privacy-valve-confirm button:not(.danger)");
    Object.assign(s, { activeChatId: "chat-2", revealMsgId: "missing" });
    await view.draw();
    Object.assign(s, { messages: [...s.messages] });
    await view.draw();
    await act(async () => view.root.unmount());
  });
});
