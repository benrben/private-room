import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fileSort = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));

vi.mock("./fileSort", () => ({ loadFileSort: fileSort.load, saveFileSort: fileSort.save }));

import { useWorkspaceState } from "./state";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const roots: Array<{ unmount(): void }> = [];
const timeouts: Array<() => void> = [];

type WorkspaceState = ReturnType<typeof useWorkspaceState>;

const tokenUsage = {
  total_tokens: 12,
  max_context: 64,
  estimated: false,
  breakdown: {
    system: { tokens: 1, estimated: false },
    history: { tokens: 2, estimated: false },
    tools: { tokens: 3, estimated: false },
    skills: { tokens: 2, estimated: false },
    files: { tokens: 4, estimated: false },
  },
};

function HookHost({ capture }: { capture: { current: WorkspaceState | null } }) {
  capture.current = useWorkspaceState({} as never);
  return null;
}

async function renderHook() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Object.defineProperty(window, "setTimeout", {
    configurable: true,
    value: (callback: () => void) => {
      timeouts.push(callback);
      return timeouts.length;
    },
  });
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  roots.push(root);
  const capture: { current: WorkspaceState | null } = { current: null };
  await act(async () => root.render(createElement(HookHost, { capture })));
  return capture;
}

function current(capture: { current: WorkspaceState | null }): WorkspaceState {
  if (capture.current === null) throw new Error("workspace state did not render");
  return capture.current;
}

beforeEach(() => {
  timeouts.splice(0);
  fileSort.load.mockReset().mockReturnValue("name");
  fileSort.save.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useWorkspaceState", () => {
  it("initializes fabricated workspace state and keeps turn, privacy, usage, and sort state per chat", async () => {
    const capture = await renderHook();
    expect(current(capture).files).toEqual([]);
    expect(current(capture).activeChatId).toBeNull();
    expect(current(capture).fileSort).toBe("name");
    expect(current(capture).area).toBe("files");
    expect(fileSort.load).toHaveBeenCalledOnce();

    await act(async () => {
      current(capture).setActiveChatId("chat-a");
      current(capture).beginRun("chat-a", "run-a");
      current(capture).setAskPrivacy("chat-a", { entities_hidden: 1, replacements: 2 });
      current(capture).setChatUsage("chat-a", tokenUsage);
      current(capture).setFileSort("largest");
      current(capture).bumpNewCreation();
      current(capture).bumpNewCreation();
    });

    expect(current(capture).asking).toBe(true);
    expect(current(capture).runIdOf("chat-a")).toBe("run-a");
    expect(current(capture).askPrivacy).toEqual({ entities_hidden: 1, replacements: 2 });
    expect(current(capture).tokenUsage).toEqual(tokenUsage);
    expect(current(capture).fileSort).toBe("largest");
    expect(current(capture).newCreationSeq).toBe(2);
    expect(fileSort.save).toHaveBeenCalledWith("largest");

    await act(async () => {
      current(capture).applyToRun("chat-a", "run-a", (turn) => ({ ...turn, text: "Fabricated answer" }));
      current(capture).endRun("chat-a");
    });
    expect(current(capture).asking).toBe(false);
    expect(current(capture).streamText).toBe("");
    expect(current(capture).runIdOf("chat-a")).toBeNull();
  });

  it("stacks, expires, and clears fabricated notices and retains only relevant error history", async () => {
    const capture = await renderHook();
    await act(async () => current(capture).pushToast("success", "Saved fake file", undefined, "file-a"));
    expect(current(capture).toasts).toMatchObject([{ kind: "success", text: "Saved fake file", about: "file-a" }]);
    expect(timeouts).toHaveLength(1);

    await act(async () => timeouts[0]!());
    expect(current(capture).toasts).toEqual([]);

    await act(async () => {
      current(capture).pushToast("error", "Fake write failed", undefined, "file-a");
      current(capture).pushToast("info", "Other notice", undefined, "file-b");
    });
    expect(current(capture).errorLogRef.current.map((entry) => entry.text)).toEqual(["Fake write failed"]);
    expect(current(capture).toasts.map((toast) => toast.kind)).toEqual(["error", "info"]);

    await act(async () => current(capture).forgetToastsAbout("file-a"));
    expect(current(capture).toasts).toMatchObject([{ kind: "info", about: "file-b" }]);
    await act(async () => current(capture).dismissToast(current(capture).toasts[0]!.id));
    expect(current(capture).toasts).toEqual([]);
  });
});
