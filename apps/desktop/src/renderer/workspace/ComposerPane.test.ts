import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import Composer from "./ComposerPane";

const { act, createElement } = React;

const mocks = vi.hoisted(() => ({
  items: [] as Array<{ key: string; label: string; hint: string; insert: string; usage?: string; disabled?: boolean }>,
  note: "",
  localModel: "local-chat" as string | null,
  scope: { placeholder: "Ask this room" },
}));

vi.mock("../icons", () => ({
  CloseIcon: () => null, CloudIcon: () => null, FileTypeIcon: () => null,
  GlobeIcon: () => null, MicIcon: () => null, PaperclipIcon: () => null,
  SparkIcon: () => null, StopIcon: () => null,
}));
vi.mock("./TokenBudgetBar", () => ({ default: () => null }));
vi.mock("./composer", () => ({
  displayName: (name: string) => name.replace(/\.[^.]+$/, ""),
  openingSigil: (text: string) => (text.startsWith("#") ? "#" : text.startsWith("/") ? "/" : text.startsWith("*") ? "*" : null),
}));
vi.mock("./markup", () => ({
  isCloudEngine: (model: string) => model === "cloud",
  isCloudRoute: (model: string) => model === "cloud",
  isExternalEngine: (model: string) => model === "external",
}));
vi.mock("./chatActions", () => ({
  currentTurnScope: () => mocks.scope,
  subscribeTurnScope: () => () => undefined,
}));
vi.mock("./localModel", () => ({ bestLocalModel: () => mocks.localModel }));
vi.mock("./constants", () => ({ RECOMMENDED_MODELS: [{ name: "local" }] }));

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  navigator: globalThis.navigator,
  HTMLElement: globalThis.HTMLElement,
  HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
  Event: globalThis.Event,
  React: Reflect.get(globalThis, "React"),
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
};

afterEach(() => {
  vi.clearAllMocks();
  mocks.items = [];
  mocks.note = "";
  mocks.localModel = "local-chat";
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

function state(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    importSuggestions: [], question: "", webOn: false, mcpTools: [], advisorToolsOn: false,
    model: "local", ai: { models: [] }, files: [], folders: [], attachments: [], skills: [],
    ac: null, showHelp: false, commands: [], asking: false,
    composerRef: { current: { focus: vi.fn() } }, pushToast: vi.fn(), setShowHelp: vi.fn(),
    setQuestion: vi.fn(),
    ...overrides,
  };
}

function actions(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    applyAllImportSuggestions: vi.fn(async () => undefined), applyImportSuggestion: vi.fn(),
    dismissAllImportSuggestions: vi.fn(), dismissImportSuggestion: vi.fn(), changeModel: vi.fn(async () => undefined),
    toggleAttach: vi.fn(), autocompleteItems: vi.fn(() => mocks.items), autocompleteNote: vi.fn(() => mocks.note),
    acceptAutocomplete: vi.fn(), refreshAutocomplete: vi.fn(), dismissAutocomplete: vi.fn(), onComposerPaste: vi.fn(),
    onComposerKeyDown: vi.fn(), insertComposerToken: vi.fn(), micState: vi.fn(() => ({ cls: "idle", title: "Start dictation", disabled: false })),
    dictateTo: vi.fn(), stopAsk: vi.fn(), send: vi.fn(async () => undefined),
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
  Reflect.set(globalThis, "HTMLTextAreaElement", window.HTMLTextAreaElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Composer, { s: s as never, a: a as never }));
    await Promise.resolve();
  });
  return { a, document, host, root, s, window };
}

function reactProp(element: Element, name: string): (event: Record<string, unknown>) => void {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error(`React props missing for ${name}`);
  return (element as unknown as Record<string, Record<string, (event: Record<string, unknown>) => void>>)[key][name];
}

async function click(view: Awaited<ReturnType<typeof renderPane>>, text: string) {
  const button = [...view.host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  await act(async () => button.dispatchEvent(new view.window.Event("click", { bubbles: true })));
}

async function clickTitle(view: Awaited<ReturnType<typeof renderPane>>, title: string) {
  const button = view.host.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  if (!button) throw new Error(`button not found: ${title}`);
  await act(async () => button.dispatchEvent(new view.window.Event("click", { bubbles: true })));
}

async function clickAria(view: Awaited<ReturnType<typeof renderPane>>, label: string) {
  const button = view.host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`button not found: ${label}`);
  await act(async () => button.dispatchEvent(new view.window.Event("click", { bubbles: true })));
}

describe("ComposerPane", () => {
  it("keeps cloud/reach, import-review, and image-attachment actions wired to local callbacks", async () => {
    const image = { id: "image-1", name: "Receipt.png", mimeType: "image/png" };
    const s = state({
      model: "cloud", ai: { models: ["local-chat", "cloud"] }, question: "Please read receipt",
      webOn: true, mcpTools: ["calendar"], files: [image],
      importSuggestions: [
        { fileId: "one", current: "one.txt", suggestion: { title: "One", folder: null } },
        { fileId: "two", current: "two.txt", suggestion: { title: "Two", folder: "Archive" } },
      ],
    });
    const view = await renderPane(s);

    expect(view.host.textContent).toContain("This will leave your Mac");
    expect(view.host.textContent).toContain("The AI can only see Receipt");
    await click(view, "Use local");
    expect(view.a.changeModel).toHaveBeenCalledWith("local-chat");
    await click(view, "Attach it");
    expect(view.a.toggleAttach).toHaveBeenCalledWith(image);
    await click(view, "Review");
    expect(view.host.textContent).toContain("Tidy up one");
    await act(async () => view.root.unmount());
  });

  it("renders cloud, web, and connected-tool notices while hiding unreachable or empty-route notices", async () => {
    const cloudWithReach = await renderPane(state({
      model: "cloud", question: "send this", webOn: true, mcpTools: ["calendar"],
    }));
    const cloudStrip = cloudWithReach.host.querySelector(".cloud-strip");
    expect(cloudStrip?.textContent).toContain("This will leave your Mac — this room can also reach the internet.");
    expect(cloudStrip?.getAttribute("title")).toContain("Web search: on");
    expect(cloudStrip?.getAttribute("title")).toContain("Connected tools: calendar");
    await act(async () => cloudWithReach.root.unmount());

    const cloudWithoutReach = await renderPane(state({ model: "cloud", question: "send this" }));
    expect(cloudWithoutReach.host.querySelector(".cloud-strip")?.textContent).toContain("This will leave your Mac.");
    expect(cloudWithoutReach.host.textContent).not.toContain("also reach the internet");
    await act(async () => cloudWithoutReach.root.unmount());

    const emptyCloudQuestion = await renderPane(state({
      model: "cloud", question: "  ", mcpTools: ["notes"],
    }));
    expect(emptyCloudQuestion.host.querySelector(".cloud-strip")).toBeNull();
    expect(emptyCloudQuestion.host.querySelector(".mcp-badge")?.getAttribute("title"))
      .toBe("Connected tools: notes");
    await act(async () => emptyCloudQuestion.root.unmount());

    const webOnly = await renderPane(state({ webOn: true }));
    expect(webOnly.host.querySelector(".mcp-badge")?.getAttribute("title")).toBe("Web search: on");
    await act(async () => webOnly.root.unmount());

    const unapprovedExternal = await renderPane(state({ model: "external", mcpTools: ["remote"] }));
    expect(unapprovedExternal.host.querySelector(".cloud-strip, .mcp-badge")).toBeNull();
    await act(async () => unapprovedExternal.root.unmount());

    const approvedExternal = await renderPane(state({
      model: "external", mcpTools: ["remote"], advisorToolsOn: true,
    }));
    expect(approvedExternal.host.querySelector(".mcp-badge")?.getAttribute("title"))
      .toBe("Connected tools: remote");
    await act(async () => approvedExternal.root.unmount());
  });

  it("explains the local-model absence from the cloud reachability notice without changing models", async () => {
    mocks.localModel = null;
    const s = state({ model: "cloud", question: "private draft" });
    const view = await renderPane(s);

    expect(view.host.querySelector(".cloud-strip-action")?.getAttribute("title"))
      .toBe("No on-device model is installed yet");
    await click(view, "Use local");

    expect(s.pushToast).toHaveBeenCalledWith(
      "info",
      "No on-device model is installed yet — download one in Settings → AI model.",
    );
    expect(view.a.changeModel).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });

  it("renders and accepts autocomplete, updates the textarea, and drives dictation/send controls", async () => {
    mocks.items = [{ key: "skill-review", label: "/review", hint: "Review a file", insert: "/review ", usage: "Skill" }];
    const s = state({
      question: "/rev", ac: { kind: "skill", query: "rev", index: 0 },
      skills: [{ id: "skill-1", name: "review", description: "Review", enabled: true }],
    });
    const view = await renderPane(s);
    const textarea = view.host.querySelector("textarea");
    const option = view.host.querySelector("button[role='option']");
    if (!textarea || !option) throw new Error("composer controls missing");

    expect(textarea.getAttribute("aria-activedescendant")).toBe("ac-opt-0");
    await act(async () => reactProp(option, "onMouseDown")({ preventDefault: vi.fn() }));
    expect(view.a.acceptAutocomplete).toHaveBeenCalledWith("/review ");
    await act(async () => reactProp(textarea, "onChange")({ target: { value: "next", selectionStart: 4 } }));
    expect(s.setQuestion).toHaveBeenCalledWith("next");
    expect(view.a.refreshAutocomplete).toHaveBeenCalledWith("next", 4);
    await click(view, "Attach");
    expect(view.a.insertComposerToken).toHaveBeenCalledWith("@");
    await clickTitle(view, "Start dictation");
    const paint = view.a.dictateTo.mock.calls[0]![1] as (text: string) => void;
    paint("spoken");
    expect(s.setQuestion).toHaveBeenCalledWith("/rev spoken");
    await clickAria(view, "Send");
    expect(view.a.send).toHaveBeenCalledTimes(1);
    await act(async () => view.root.unmount());
  });

  it("labels fabricated command, skill, specialist, and reference autocomplete results", async () => {
    mocks.items = [
      { key: "cmd-one", label: "#one", hint: "First command", insert: "#one " },
      { key: "cmd-two", label: "#two", hint: "Second command", insert: "#two " },
    ];
    const commands = await renderPane(state({ ac: { kind: "cmd", query: "", index: 9 } }));
    expect(commands.host.querySelector(".ac-hint")?.textContent).toContain("2 commands");
    expect(commands.host.querySelector("textarea")?.getAttribute("aria-activedescendant")).toBe("ac-opt-1");
    await act(async () => commands.root.unmount());

    mocks.items = [{ key: "review", label: "/review", hint: "Review", insert: "/review " }];
    const skills = await renderPane(state({
      ac: { kind: "skill", query: "rev", index: 0 },
      skills: [
        { id: "review", name: "review", description: "Review", enabled: true },
        { id: "revise", name: "revise", description: "Revise", enabled: true },
        { id: "disabled", name: "revoked", description: "Disabled", enabled: false },
      ],
    }));
    expect(skills.host.querySelector(".ac-hint")?.textContent).toContain("1 of 2 enabled skills");
    await act(async () => skills.root.unmount());

    mocks.items = [];
    mocks.note = "No fabricated specialists are available.";
    const specialists = await renderPane(state({ ac: { kind: "agent", query: "", index: 0 } }));
    expect(specialists.host.querySelector(".ac-hint")?.textContent).toContain("Specialists");
    expect(specialists.host.textContent).toContain("No fabricated specialists are available.");
    await act(async () => specialists.root.unmount());

    mocks.items = [{ key: "specialist", label: "*reviewer", hint: "Review", insert: "*reviewer " }];
    mocks.note = "";
    const availableSpecialists = await renderPane(state({ ac: { kind: "agent", query: "", index: 0 } }));
    expect(availableSpecialists.host.querySelector(".ac-hint")?.textContent).toContain("1 specialists");
    await act(async () => availableSpecialists.root.unmount());

    mocks.items = [{ key: "file-note", label: "notes.md", hint: "File", insert: "@notes.md " }];
    mocks.note = "";
    const references = await renderPane(state({
      ac: { kind: "ref", query: "note", index: 0 },
      files: [
        { id: "one", name: "notes.md", mimeType: "text/markdown" },
        { id: "two", name: "other.md", mimeType: "text/markdown" },
      ],
      folders: [{ id: "folder", name: "meeting notes" }],
    }));
    expect(references.host.querySelector(".ac-hint")?.textContent).toContain("1 of 2 files & folders");
    await act(async () => references.root.unmount());
  });

  it("wires every available composer tool and stops an active fabricated answer", async () => {
    const s = state({
      asking: true,
      question: "*delegate this",
      skills: [{ id: "skill-1", name: "review", description: "Review", enabled: true }],
    });
    const view = await renderPane(s);
    const specialist = view.host.querySelector<HTMLButtonElement>('button[title="Send this turn to one specialist agent"]');
    const skill = view.host.querySelector<HTMLButtonElement>('button[title="Use a specific enabled skill for this answer"]');
    if (!specialist || !skill) throw new Error("composer tool buttons missing");

    expect(specialist.className).toContain("is-on");
    expect(skill.disabled).toBe(false);
    await click(view, "Attach");
    await clickTitle(view, "Run a prebuilt action");
    await clickTitle(view, "Use a specific enabled skill for this answer");
    await clickTitle(view, "Send this turn to one specialist agent");
    expect(view.a.insertComposerToken).toHaveBeenNthCalledWith(1, "@");
    expect(view.a.insertComposerToken).toHaveBeenNthCalledWith(2, "#");
    expect(view.a.insertComposerToken).toHaveBeenNthCalledWith(3, "/");
    expect(view.a.insertComposerToken).toHaveBeenNthCalledWith(4, "*");

    await clickTitle(view, "Start dictation");
    const paint = view.a.dictateTo.mock.calls[0]![1] as (text: string) => void;
    paint("spoken");
    expect(s.setQuestion).toHaveBeenCalledWith("*delegate this spoken");
    await clickAria(view, "Stop this answer");
    expect(view.a.stopAsk).toHaveBeenCalledTimes(1);
    await act(async () => view.root.unmount());
  });

  it("shows help and attachment chips, and closes help through its local control", async () => {
    const file = { id: "file-1", name: "Notes.md", mimeType: "text/markdown" };
    const s = state({
      showHelp: true, attachments: [file], commands: [{ name: "summarize", usage: "#summarize", summary: "Summarize" }],
    });
    const view = await renderPane(s);

    expect(view.host.querySelector(".attach-row")?.getAttribute("aria-label")).toBe("1 attached file");
    expect(view.host.textContent).toContain("#summarize");

    const command = view.host.querySelector(".help-popover .ac-item");
    if (!command) throw new Error("help command missing");
    const focus = vi.fn();
    s.composerRef.current.focus = focus;
    const preventDefault = vi.fn();
    await act(async () => reactProp(command, "onMouseDown")({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(s.setQuestion).toHaveBeenCalledWith("#summarize ");
    expect(focus).toHaveBeenCalledOnce();

    const escape = new view.window.Event("keydown", { bubbles: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    const stopPropagation = vi.spyOn(escape, "stopPropagation");
    await act(async () => view.window.dispatchEvent(escape));
    expect(stopPropagation).toHaveBeenCalledOnce();
    await clickTitle(view, "Close");
    expect(s.setShowHelp).toHaveBeenCalledTimes(3);
    expect(s.setShowHelp).toHaveBeenLastCalledWith(false);
    await act(async () => view.root.unmount());
  });
});
