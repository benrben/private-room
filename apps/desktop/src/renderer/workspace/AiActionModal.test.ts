import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

const modal = vi.hoisted(() => ({
  tokenAtCaret: vi.fn(),
  isCloudRoute: vi.fn(),
}));

vi.mock("../icons", () => ({ CloudIcon: () => null }));
vi.mock("./composer", () => ({ tokenAtCaret: modal.tokenAtCaret }));
vi.mock("./markup", () => ({ isCloudRoute: modal.isCloudRoute }));

import AiActionModal from "./AiActionModal";

const { act, createElement } = React;
const globalKeys = [
  "document",
  "window",
  "navigator",
  "Node",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type Mutable = Record<string, any>;

function prompt(overrides: Mutable = {}) {
  return {
    def: {
      id: "summarize",
      title: "Summarize",
      description: "Make a compact summary.",
      scope: "room",
      needsQuestion: false,
      needsLanguage: false,
      defaultPrompt: "",
    },
    scope: null,
    refs: null,
    text: "Read this",
    question: "",
    ...overrides,
  };
}

function workspace(overrides: Mutable = {}): Mutable {
  const value: Mutable = {
    aiPrompt: prompt(),
    aiBusy: false,
    aiStopping: false,
    aiOpId: null,
    studioAc: null,
    model: "local",
    ai: {},
    studioPromptRef: { current: null },
    ...overrides,
  };
  value.setAiPrompt = vi.fn((next: unknown) => {
    value.aiPrompt = typeof next === "function" ? next(value.aiPrompt) : next;
  });
  value.setStudioAc = vi.fn((next: unknown) => {
    value.studioAc = typeof next === "function" ? next(value.studioAc) : next;
  });
  return value;
}

function actions(overrides: Mutable = {}): Mutable {
  return {
    studioAcItems: vi.fn(() => []),
    acceptMention: vi.fn(),
    runAiActionFromModal: vi.fn(),
    stopAiAction: vi.fn(),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(s: Mutable, a: Mutable) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "Node", window.Node);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "HTMLTextAreaElement", window.HTMLTextAreaElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const update = async () => {
    await act(async () => {
      root.render(
        createElement(AiActionModal, {
          s: s as React.ComponentProps<typeof AiActionModal>["s"],
          a: a as React.ComponentProps<typeof AiActionModal>["a"],
        }),
      );
    });
    await flush();
  };
  await update();
  return { host, root, s, a, update, window };
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) =>
    name.startsWith("__reactProps"),
  );
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => {
    node.dispatchEvent(
      new window.Event("click", { bubbles: true, cancelable: true }),
    );
  });
  await flush();
}

async function key(
  node: Element,
  event: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean }>,
) {
  const preventDefault = vi.fn();
  await act(async () => {
    reactProps<{
      onKeyDown: (value: {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        preventDefault: () => void;
      }) => void;
    }>(node).onKeyDown({
      key: event.key ?? "",
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      preventDefault,
    });
  });
  await flush();
  return preventDefault;
}

async function input(
  node: Element,
  value: string,
  selectionStart = value.length,
) {
  await act(async () => {
    reactProps<{
      onChange: (event: {
        target: { value: string; selectionStart: number };
      }) => void;
    }>(node).onChange({ target: { value, selectionStart } });
  });
  await flush();
}

function dispatchEscape(window: Window & typeof globalThis) {
  const event = new window.Event("keydown", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "key", { value: "Escape" });
  window.dispatchEvent(event);
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("AiActionModal", () => {
  it("renders nothing until an action is selected", async () => {
    const view = await render(workspace({ aiPrompt: null }), actions());
    expect(view.host.textContent).toBe("");
    await act(async () => view.root.unmount());
  });

  it("renders scope, cloud disclosure, language controls, and the required prompt state", async () => {
    modal.isCloudRoute.mockReturnValue(true);
    const s = workspace({
      model: "cloud",
      aiPrompt: prompt({
        refs: ["first", "second"],
        text: " ",
        question: " ",
        def: {
          ...prompt().def,
          title: "Translate",
          needsLanguage: true,
        },
      }),
    });
    const view = await render(s, actions());
    expect(view.host.textContent).toContain("Translate · these 2 files");
    expect(view.host.textContent).toContain("leave your Mac");
    expect(view.host.querySelector("datalist#ai-action-langs")).not.toBeNull();
    expect(
      view.host.querySelector<HTMLButtonElement>("button.primary")?.disabled,
    ).toBe(true);
    await act(async () => view.root.unmount());
  });

  it("binds question fields, falls through ordinary textarea keys, and runs when enabled", async () => {
    const s = workspace({
      aiPrompt: prompt({
        scope: "open-file",
        refs: ["one"],
        text: "Read this",
        question: "",
        def: { ...prompt().def, needsQuestion: true },
      }),
    });
    const a = actions();
    const view = await render(s, a);
    expect(view.host.textContent).toContain("Summarize · this file");
    expect(
      view.host.querySelector<HTMLButtonElement>("button.primary")?.disabled,
    ).toBe(true);
    const question = view.host.querySelector<HTMLInputElement>(
      "input.studio-prompt-question",
    );
    if (!question) throw new Error("question input missing");
    await input(question, "What changed?");
    expect(s.aiPrompt.question).toBe("What changed?");
    await key(question, { key: "Enter", ctrlKey: true });
    expect(a.runAiActionFromModal).toHaveBeenCalledOnce();
    await view.update();
    modal.tokenAtCaret.mockReturnValueOnce(null);
    const textarea = view.host.querySelector("textarea");
    if (!textarea) throw new Error("textarea missing");
    await input(textarea, "plain text");
    expect(s.studioAc).toBeNull();
    expect(await key(textarea, { key: "x" })).not.toHaveBeenCalled();
    await click(view.host.querySelector("button.primary")!, view.window);
    expect(a.runAiActionFromModal).toHaveBeenCalledTimes(2);
    await act(async () => view.root.unmount());
  });

  it("updates prompts and sends shortcut, autocomplete navigation, selection, and Escape to their owners", async () => {
    const s = workspace({
      studioAc: { kind: "ref", query: "note", start: 0, index: 0 },
    });
    const a = actions({
      studioAcItems: vi.fn(() => [
        { key: "one", label: "One", hint: "first", insert: "@one" },
        { key: "two", label: "Two", hint: "second", insert: "@two" },
      ]),
    });
    modal.tokenAtCaret.mockReturnValue({
      kind: "ref",
      query: "file",
      start: 2,
    });
    const view = await render(s, a);
    const textarea = view.host.querySelector("textarea");
    if (!textarea) throw new Error("textarea missing");
    await input(textarea, "@file", 5);
    expect(s.aiPrompt.text).toBe("@file");
    expect(s.studioAc).toMatchObject({ query: "file", start: 2, index: 0 });
    expect(await key(textarea, { key: "ArrowDown" })).toHaveBeenCalledOnce();
    expect(s.studioAc.index).toBe(1);
    await key(textarea, { key: "ArrowUp" });
    expect(s.studioAc.index).toBe(0);
    await key(textarea, { key: "Tab" });
    expect(a.acceptMention).toHaveBeenCalledWith(
      "@one",
      s.aiPrompt,
      s.setAiPrompt,
    );
    await key(textarea, { key: "Escape" });
    expect(s.setStudioAc).toHaveBeenCalledWith(null);
    s.studioAc = { kind: "ref", query: "file", start: 2, index: 0 };
    expect(await key(textarea, { key: "x" })).not.toHaveBeenCalled();
    s.studioAc = null;
    await key(textarea, { key: "Enter", metaKey: true });
    expect(a.runAiActionFromModal).toHaveBeenCalledOnce();
    const mention = [...view.host.querySelectorAll(".ac-item")][0];
    if (!mention) throw new Error("mention missing");
    reactProps<{
      onMouseDown: (event: { preventDefault: () => void }) => void;
    }>(mention).onMouseDown({ preventDefault: vi.fn() });
    expect(a.acceptMention).toHaveBeenCalledTimes(2);
    await act(async () => view.root.unmount());
  });

  it("keeps busy modal controls guarded while Escape, backdrop, cancel, and stop retain their behavior", async () => {
    let s = workspace();
    let a = actions();
    let view = await render(s, a);
    dispatchEscape(view.window);
    expect(s.setAiPrompt).toHaveBeenCalledWith(null);
    await view.update();
    await act(async () => view.root.unmount());

    s = workspace({ aiBusy: true, aiOpId: "operation" });
    a = actions();
    view = await render(s, a);
    dispatchEscape(view.window);
    expect(s.setAiPrompt).not.toHaveBeenCalled();
    await click(
      view.host.querySelector(".studio-prompt-backdrop")!,
      view.window,
    );
    expect(s.setAiPrompt).not.toHaveBeenCalled();
    await click(
      [...view.host.querySelectorAll("button")].find((node) =>
        node.textContent?.includes("Stop"),
      )!,
      view.window,
    );
    expect(a.stopAiAction).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());

    s = workspace({
      studioAc: { kind: "ref", query: "x", start: 0, index: 0 },
    });
    view = await render(s, actions());
    dispatchEscape(view.window);
    expect(s.setAiPrompt).not.toHaveBeenCalled();
    await click(
      [...view.host.querySelectorAll("button")].find((node) =>
        node.textContent?.includes("Cancel"),
      )!,
      view.window,
    );
    expect(s.setAiPrompt).toHaveBeenCalledWith(null);
    await act(async () => view.root.unmount());
  });
});
