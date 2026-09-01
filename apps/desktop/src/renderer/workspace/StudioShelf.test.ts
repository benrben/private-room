import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WSActions } from "./actions";
import StudioShelf from "./StudioShelf";
import type { WSState } from "./state";

const { act, createElement } = React;

vi.mock("../icons", () => ({
  GraphIcon: () => null,
  PodcastIcon: () => null,
  StudioIcon: () => null,
}));

const globalKeys = [
  "document",
  "Event",
  "HTMLElement",
  "IS_REACT_ACT_ENVIRONMENT",
  "React",
  "window",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function state(overrides: Record<string, unknown> = {}): WSState {
  return { aiActionDefs: null, aiBusy: false, jobs: [], ...overrides } as unknown as WSState;
}

function actions(overrides: Record<string, unknown> = {}): WSActions {
  return {
    openAiAction: vi.fn(),
    openStudioPrompt: vi.fn(),
    ...overrides,
  } as unknown as WSActions;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderShelf(s = state(), a = actions(), scope?: string) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "window", window);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(StudioShelf, { a, s, scope }));
  });
  await flush();
  return {
    a,
    close: async () => act(async () => root.unmount()),
    host,
    window,
  };
}

function button(view: Awaited<ReturnType<typeof renderShelf>>, text: string) {
  const found = [...view.host.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`Button ${text} missing`);
  return found as HTMLButtonElement;
}

async function click(view: Awaited<ReturnType<typeof renderShelf>>, element: Element) {
  await act(async () => {
    element.dispatchEvent(new view.window.Event("click", { bubbles: true }));
  });
  await flush();
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("StudioShelf", () => {
  it("marks only active studio kinds in the current scope as working", async () => {
    const a = actions();
    const view = await renderShelf(state({
      jobs: [
        { id: "flash", kind: "studio", status: "queued", plan: { kind: "flashcards", scope: "notes" } },
        { id: "mind", kind: "studio", status: "done", plan: { kind: "mindmap", scope: "notes" } },
        { id: "podcast", kind: "studio", status: "running", plan: { kind: "podcast", scope: "elsewhere" } },
        { id: "other", kind: "index", status: "running", plan: { kind: "mindmap", scope: "notes" } },
      ],
    }), a, "notes");

    const flashcards = button(view, "Flashcards");
    const mindmap = button(view, "Mind map");
    const podcast = button(view, "Podcast script");
    expect(flashcards.disabled).toBe(true);
    expect(flashcards.textContent).toContain("Working…");
    expect(mindmap.disabled).toBe(false);
    expect(podcast.disabled).toBe(false);
    await click(view, mindmap);
    await click(view, podcast);
    expect(a.openStudioPrompt).toHaveBeenNthCalledWith(1, "mindmap", "notes");
    expect(a.openStudioPrompt).toHaveBeenNthCalledWith(2, "podcast", "notes");
    await view.close();
  });

  it("shows only room AI actions and forwards the current scope", async () => {
    const roomAction = {
      id: "summarize",
      title: "Summarize room",
      description: "Create a short summary",
      scope: "room" as const,
      needsQuestion: false,
      needsLanguage: false,
      defaultPrompt: "",
    };
    const view = await renderShelf(state({
      aiActionDefs: [roomAction, { ...roomAction, id: "file-only", title: "File action", scope: "file" }],
    }), actions(), "folder-a");

    expect(view.host.textContent).toContain("AI actions · this folder");
    expect(view.host.textContent).not.toContain("File action");
    const action = button(view, "Summarize room");
    expect(action.title).toBe("Create a short summary");
    await click(view, action);
    expect(view.a.openAiAction).toHaveBeenCalledWith(roomAction, "folder-a", null);
    await view.close();
  });

  it("disables room actions while an AI action is already running", async () => {
    const view = await renderShelf(state({
      aiBusy: true,
      aiActionDefs: [{
        id: "summarize",
        title: "Summarize room",
        description: "Create a short summary",
        scope: "room",
        needsQuestion: false,
        needsLanguage: false,
        defaultPrompt: "",
      }],
    }));

    expect(button(view, "Summarize room").disabled).toBe(true);
    await view.close();
  });
});
