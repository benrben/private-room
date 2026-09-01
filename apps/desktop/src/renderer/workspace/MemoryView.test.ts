import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Memory } from "../api";

const bridge = vi.hoisted(() => ({
  deleteMemory: vi.fn<(id: string) => Promise<void>>(),
  listFiles: vi.fn(),
  listMemories: vi.fn<() => Promise<Memory[]>>(),
  saveGeneratedFile: vi.fn(),
  setSetting: vi.fn<() => Promise<void>>(),
}));

vi.mock("../api", () => ({ api: bridge }));
vi.mock("../icons", () => ({
  CheckIcon: () => null,
  CloseIcon: () => null,
  MemoryIcon: () => null,
  MicIcon: () => null,
  PencilIcon: () => null,
  SearchIcon: () => null,
}));
vi.mock("./composer", () => ({
  formatWhen: (when: string) => when.slice(0, 10),
  uniqueFileName: (name: string, existing: string[]) =>
    existing.includes(name) ? `Copy of ${name}` : name,
}));
vi.mock("./markup", () => ({
  isCloudRoute: (model: string) => model === "cloud",
  trustState: (cloud: boolean, privacyOn: boolean | null) => ({
    tone: cloud ? (privacyOn === false ? "danger" : "warn") : "good",
  }),
}));
vi.mock("./DeleteControl", () => ({
  default: ({ title, onConfirm }: { title: string; onConfirm: () => void }) =>
    React.createElement("button", { "aria-label": title, onClick: onConfirm }, "forget"),
}));

import MemoryView from "./MemoryView";

const { act, createElement } = React;
type MemoryViewProps = React.ComponentProps<typeof MemoryView>;

const globalKeys = [
  "document",
  "window",
  "navigator",
  "Node",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

function memory(
  id: string,
  content: string,
  category: string | null,
  createdAt: string,
): Memory {
  return { id, content, category, createdAt };
}

function resetBridge() {
  bridge.deleteMemory.mockReset().mockResolvedValue();
  bridge.listFiles.mockReset().mockResolvedValue([]);
  bridge.listMemories.mockReset().mockResolvedValue([]);
  bridge.saveGeneratedFile.mockReset().mockResolvedValue({ name: "memory.md" });
  bridge.setSetting.mockReset().mockResolvedValue();
}

type State = Record<string, unknown>;

function stateWith(memories: Memory[] = [], overrides: State = {}) {
  const state: State = {
    memories,
    files: [],
    memoryDraft: "",
    memoryDraftCat: "",
    editingMemory: null,
    showMemoryIntro: false,
    model: "local",
    ai: null,
    privacyOn: true,
    dictOwner: null,
    dictState: "idle",
    confirmDelete: null,
    setFiles: vi.fn(),
    setMemories: vi.fn(),
    setShowMemoryIntro: vi.fn(),
    setMemoryDraft: vi.fn((next: string | ((previous: string) => string)) => {
      const current = state.memoryDraft as string;
      state.memoryDraft = typeof next === "function" ? next(current) : next;
    }),
    setMemoryDraftCat: vi.fn((next: string) => {
      state.memoryDraftCat = next;
    }),
    setEditingMemory: vi.fn((next: unknown) => {
      state.editingMemory = next;
    }),
    pushToast: vi.fn(),
    ...overrides,
  };
  return state;
}

function actionsWith(overrides: State = {}) {
  return {
    addMemory: vi.fn(),
    askConfirm: vi.fn(),
    cancelConfirm: vi.fn(),
    dictateTo: vi.fn(),
    micState: vi.fn(() => ({ cls: "idle", disabled: false })),
    openScratchPad: vi.fn(),
    saveMemoryEdit: vi.fn(),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderMemory(state: State, actions: State = {}) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "Node", window.Node);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  const workspaceActions = actionsWith(actions);
  const render = async () => {
    await act(async () => {
      root.render(
        createElement(MemoryView, {
          s: state as unknown as MemoryViewProps["s"],
          a: workspaceActions as unknown as MemoryViewProps["a"],
          info: { name: "Private Room" } as MemoryViewProps["info"],
        }),
      );
    });
    await flush();
  };
  await render();
  return { host, root, state, actions: workspaceActions, render };
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) =>
    name.startsWith("__reactProps"),
  );
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function click(node: Element) {
  await act(async () => {
    reactProps<{ onClick: () => void }>(node).onClick();
  });
  await flush();
}

async function change(node: Element, value: string) {
  await act(async () => {
    reactProps<{ onChange: (event: { target: { value: string } }) => void }>(
      node,
    ).onChange({ target: { value } });
  });
  await flush();
}

async function key(node: Element, value: string) {
  await act(async () => {
    reactProps<{ onKeyDown: (event: { key: string }) => void }>(node).onKeyDown({
      key: value,
    });
  });
  await flush();
}

function button(host: Element, label: string) {
  const found = host.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

function textButton(host: Element, text: string) {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found;
}

beforeEach(resetBridge);

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("MemoryView", () => {
  it("keeps first-run examples and dictation local to the draft", async () => {
    const state = stateWith([], { showMemoryIntro: true });
    const view = await renderMemory(state);
    expect(state.setShowMemoryIntro).toHaveBeenCalledWith(false);
    expect(bridge.setSetting).toHaveBeenCalledWith("memory_intro_seen", "1");
    expect(view.host.textContent).toContain("Nothing saved yet");
    expect(view.host.textContent).toContain("Answer in British English");
    await click(button(view.host, "Speak a memory"));
    const dictate = view.actions.dictateTo.mock.calls[0]?.[1];
    if (!dictate) throw new Error("dictation callback missing");
    dictate("Recorded memory");
    expect(state.memoryDraft).toBe("Recorded memory");
    state.dictOwner = "memory";
    state.dictState = "recording";
    await view.render();
    expect(button(view.host, "Stop recording")).toBeTruthy();
    expect(view.actions.openScratchPad).not.toHaveBeenCalled();
    await click(textButton(view.host, "Open the scratch pad"));
    expect(view.actions.openScratchPad).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });

  it("filters, reverses, edits, saves, and forgets grouped memories", async () => {
    const oldest = memory("oldest", "Tea before meetings", "preference", "2026-08-01T00:00:00Z");
    const newerPreference = memory("newer-preference", "Tea after meetings", "preference", "2026-08-04T00:00:00Z");
    const newest = memory("newest", "Review project notes", "project", "2026-08-03T00:00:00Z");
    const other = memory("other", "Legacy item", "legacy", "2026-08-02T00:00:00Z");
    const state = stateWith([oldest, newerPreference, newest, other], {
      files: [{ name: "Memory — Private Room.md" }],
    });
    bridge.saveGeneratedFile.mockResolvedValue({ name: "Copy of Memory — Private Room.md" });
    bridge.listFiles.mockResolvedValue([{ name: "saved.md" }]);
    bridge.listMemories.mockResolvedValue([newest]);
    const view = await renderMemory(state);
    expect(view.host.textContent).toContain("Preferences");
    expect(view.host.textContent).toContain("Projects");
    expect(view.host.textContent).toContain("Other");
    const cards = [...view.host.querySelectorAll(".mem-card-body")];
    expect(cards.map((card) => card.textContent)).toEqual([
      "Tea before meetings",
      "Tea after meetings",
      "Review project notes",
      "Legacy item",
    ]);

    const order = [...view.host.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes("Oldest first"),
    );
    if (!order) throw new Error("order button missing");
    await click(order);
    expect(
      [...view.host.querySelectorAll(".mem-card-body")].map((card) => card.textContent),
    ).toEqual([
      "Tea after meetings",
      "Tea before meetings",
      "Review project notes",
      "Legacy item",
    ]);

    const filter = view.host.querySelector<HTMLInputElement>(
      'input[aria-label="Filter memories"]',
    );
    if (!filter) throw new Error("filter missing");
    await change(filter, "tea");
    expect(view.host.textContent).toContain("Tea before meetings");
    expect(view.host.textContent).not.toContain("Review project notes");
    await change(filter, "no match");
    expect(view.host.textContent).toContain("No memory matches “no match”");
    await click(button(view.host, "Clear the filter"));

    await click(button(view.host, "Edit this memory"));
    expect(state.setEditingMemory).toHaveBeenCalledWith({
      id: "newer-preference",
      content: "Tea after meetings",
      category: "preference",
    });
    state.editingMemory = {
      id: "newer-preference",
      content: "Edited project note",
      category: "preference",
    };
    await view.render();
    const edit = view.host.querySelector<HTMLInputElement>(
      'input[aria-label="Edit this memory"]',
    );
    if (!edit) throw new Error("edit input missing");
    await change(edit, "Edited again");
    const category = view.host.querySelector<HTMLSelectElement>(
      'select[aria-label="Category"]',
    );
    if (!category) throw new Error("edit category missing");
    await change(category, "");
    await key(edit, "Enter");
    await key(edit, "Escape");
    expect(view.actions.saveMemoryEdit).toHaveBeenCalledOnce();
    expect(state.setEditingMemory).toHaveBeenLastCalledWith(null);

    await click(textButton(view.host, "Save as a note"));
    expect(bridge.saveGeneratedFile).toHaveBeenCalledWith(
      "Copy of Memory — Private Room.md",
      expect.stringContaining("## Preferences"),
    );
    expect(bridge.saveGeneratedFile.mock.calls[0]?.[1]).toContain(
      "- Review project notes  _(added 2026-08-03)_",
    );
    expect(state.setFiles).toHaveBeenCalledWith([{ name: "saved.md" }]);
    expect(state.pushToast).toHaveBeenCalledWith(
      "success",
      'Saved "Copy of Memory — Private Room.md" into the room.',
    );

    await click(button(view.host, "Forget this"));
    expect(bridge.deleteMemory).toHaveBeenCalledWith("oldest");
    expect(state.setMemories).toHaveBeenCalledWith([newest]);
    await act(async () => view.root.unmount());
  });

  it("names save and delete failures while still refreshing a stale list", async () => {
    const row = memory("row", "Private fact", "fact", "2026-08-02T00:00:00Z");
    const state = stateWith([row]);
    bridge.saveGeneratedFile.mockRejectedValue(new Error("disk full"));
    bridge.deleteMemory.mockRejectedValue(new Error("not in this room"));
    bridge.listMemories.mockRejectedValue(new Error("refresh failed"));
    const view = await renderMemory(state);
    await click(textButton(view.host, "Save as a note"));
    await click(button(view.host, "Forget this"));
    expect(state.pushToast).toHaveBeenCalledWith("error", "Error: disk full");
    expect(state.pushToast).toHaveBeenCalledWith(
      "error",
      "Could not forget that memory: Error: not in this room",
    );
    expect(state.pushToast).toHaveBeenCalledWith("error", "Error: refresh failed");
    await act(async () => view.root.unmount());
  });
});
