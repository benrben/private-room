import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tokenAtCaret: vi.fn() }));
vi.mock("./composer", () => ({ tokenAtCaret: mocks.tokenAtCaret }));

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
type Mutable = Record<string, any>;

function state(overrides: Mutable = {}): Mutable {
  const s: Mutable = {
    studioPrompt: { kind: "flashcards", text: "Make cards" },
    studioAc: { kind: "ref", query: "note", start: 0, index: 0 },
    studioPromptRef: { current: null },
    ...overrides,
  };
  s.setStudioPrompt = vi.fn((next: unknown) => { s.studioPrompt = typeof next === "function" ? next(s.studioPrompt) : next; });
  s.setStudioAc = vi.fn((next: unknown) => { s.studioAc = typeof next === "function" ? next(s.studioAc) : next; });
  return s;
}

function actions(overrides: Mutable = {}): Mutable {
  return {
    studioAcItems: vi.fn(() => [{ key: "note", label: "Note", hint: "a note", insert: "@note" }]),
    acceptMention: vi.fn(), runStudioFromModal: vi.fn(), ...overrides,
  };
}

async function render(s = state(), a = actions()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window); Reflect.set(globalThis, "document", document); Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement); Reflect.set(globalThis, "Event", window.Event); Reflect.set(globalThis, "React", React); Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  const [{ createRoot }, { default: StudioModal }] = await Promise.all([import("react-dom/client"), import("./StudioModal")]);
  const host = document.getElementById("root"); if (!host) throw new Error("test root missing"); const root = createRoot(host);
  await act(async () => {
    root.render(createElement(StudioModal, {
      s: s as React.ComponentProps<typeof StudioModal>["s"],
      a: a as React.ComponentProps<typeof StudioModal>["a"],
    }));
    await Promise.resolve();
  });
  return { host, s, a, window, close: async () => act(async () => root.unmount()) };
}

function handler(element: Element, name: string) {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps")); if (!key) throw new Error("React props missing");
  return (element as unknown as Record<string, Record<string, (event: any) => void>>)[key][name];
}

function keyEvent(key: string, extras: Mutable = {}) { return { key, metaKey: false, ctrlKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extras }; }

beforeEach(() => mocks.tokenAtCaret.mockReset());
afterEach(() => { vi.clearAllMocks(); for (const [key, value] of Object.entries(originalGlobals)) { if (value === undefined) Reflect.deleteProperty(globalThis, key); else Reflect.set(globalThis, key, value); } });

describe("StudioModal", () => {
  it("updates refs and routes each autocomplete key to mocked workspace actions", async () => {
    mocks.tokenAtCaret.mockReturnValue({ kind: "ref", query: "fresh", start: 1 });
    const view = await render(); const textarea = view.host.querySelector("textarea"); if (!textarea) throw new Error("prompt missing");
    handler(textarea, "onChange")({ target: { value: "@fresh", selectionStart: 6 } });
    expect(view.s.studioPrompt.text).toBe("@fresh"); expect(view.s.studioAc).toMatchObject({ query: "fresh", index: 0 });
    handler(textarea, "onKeyDown")(keyEvent("ArrowDown")); expect(view.s.studioAc.index).toBe(0);
    handler(textarea, "onKeyDown")(keyEvent("ArrowUp"));
    handler(textarea, "onKeyDown")(keyEvent("Tab")); expect(view.a.acceptMention).toHaveBeenCalledWith("@note", view.s.studioPrompt, view.s.setStudioPrompt);
    handler(textarea, "onKeyDown")(keyEvent("Escape")); expect(view.s.setStudioAc).toHaveBeenCalledWith(null);
    view.s.studioAc = null; handler(textarea, "onKeyDown")(keyEvent("Enter", { ctrlKey: true })); expect(view.a.runStudioFromModal).toHaveBeenCalledOnce();
    await view.close();
  });

  it("uses the active item and keeps modal close actions available", async () => {
    const view = await render(); const item = view.host.querySelector(".ac-item"); if (!item) throw new Error("suggestion missing");
    handler(item, "onMouseDown")({ preventDefault: vi.fn() }); expect(view.a.acceptMention).toHaveBeenCalledOnce();
    const cancel = [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Cancel"); if (!cancel) throw new Error("cancel missing");
    handler(cancel, "onClick")({}); expect(view.s.setStudioPrompt).toHaveBeenCalledWith(null);
    const backdrop = view.host.querySelector(".studio-prompt-backdrop"); const dialog = view.host.querySelector(".studio-prompt");
    if (!backdrop || !dialog) throw new Error("modal shell missing");
    handler(dialog, "onClick")({ stopPropagation: vi.fn() }); handler(backdrop, "onClick")({});
    const run = view.host.querySelector("button.primary"); if (!run) throw new Error("run missing"); handler(run, "onClick")({});
    view.s.studioAc = null;
    const escape = new view.window.Event("keydown"); Object.defineProperty(escape, "key", { value: "Escape" }); Object.defineProperty(escape, "stopPropagation", { value: vi.fn() });
    view.window.dispatchEvent(escape);
    expect(view.a.runStudioFromModal).toHaveBeenCalledOnce(); expect(view.s.setStudioPrompt).toHaveBeenCalledWith(null);
    await view.close();
  });

  it("keeps an empty autocomplete hidden and leaves unrelated keys alone", async () => {
    mocks.tokenAtCaret.mockReturnValue(null);
    const empty = state({
      studioPrompt: { kind: "mindmap", text: "", scope: "file-1" },
      studioAc: { kind: "ref", query: "", start: 0, index: 0 },
    });
    const emptyActions = actions({ studioAcItems: vi.fn(() => []) });
    const emptyView = await render(empty, emptyActions);
    const textarea = emptyView.host.querySelector("textarea");
    if (!textarea) throw new Error("prompt missing");
    expect(emptyView.host.textContent).toContain("Mind map · this file");
    expect(emptyView.host.querySelector(".ac-popover")).toBeNull();
    expect((emptyView.host.querySelector("button.primary") as HTMLButtonElement).disabled).toBe(true);
    handler(textarea, "onChange")({ target: { value: "plain", selectionStart: 5 } });
    expect(emptyView.s.studioAc).toBeNull();
    const unrelated = keyEvent("x");
    handler(textarea, "onKeyDown")(unrelated);
    expect(unrelated.preventDefault).not.toHaveBeenCalled();
    await emptyView.close();

    const podcast = state({
      studioPrompt: { kind: "podcast", text: "Plan it", scope: null },
      studioAc: { kind: "ref", query: "n", start: 0, index: 1 },
    });
    const podcastActions = actions({
      studioAcItems: vi.fn(() => [
        { key: "first", label: "First", hint: "first item", insert: "@first" },
        { key: "second", label: "Second", hint: "second item", insert: "@second" },
      ]),
    });
    const podcastView = await render(podcast, podcastActions);
    expect(podcastView.host.textContent).toContain("Podcast script · whole room");
    expect(podcastView.host.querySelectorAll(".ac-item.active")).toHaveLength(1);
    expect(podcastView.host.querySelector(".ac-item.active")?.textContent).toContain("Second");
    await podcastView.close();
  });
});
