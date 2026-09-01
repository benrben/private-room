import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WSState } from "./state";

const trap = vi.hoisted(() => ({ onModalKeyDown: vi.fn() }));

vi.mock("../settings/useFocusTrap", () => ({
  useFocusTrap: () => ({ modalRef: { current: null }, onModalKeyDown: trap.onModalKeyDown }),
}));

import UnsavedEditsDialog from "./UnsavedEditsDialog";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function state(save: (() => Promise<boolean>) | null, overrides: Partial<WSState> = {}) {
  const pending = { what: "closing this file", proceed: vi.fn() };
  const s = {
    pendingLeave: pending,
    setPendingLeave: vi.fn(),
    editorDirtyRef: { current: true },
    editorSaveRef: { current: save },
    openFile: null,
    ...overrides,
  } as unknown as WSState;
  return { pending, s };
}

async function render(s: WSState) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
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
  await act(async () => {
    root.render(createElement(UnsavedEditsDialog, { s }));
    await Promise.resolve();
  });
  return { host, root, s, window };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

async function click(view: Awaited<ReturnType<typeof render>>, label: string) {
  await act(async () => {
    button(view.host, label).dispatchEvent(new view.window.Event("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function close(view: Awaited<ReturnType<typeof render>>) {
  await act(async () => view.root.unmount());
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("UnsavedEditsDialog", () => {
  it("saves the named dirty file before resuming the held navigation", async () => {
    const save = vi.fn(async () => true);
    const { s, pending } = state(save, { openFile: { content: { name: "draft.md" } } as WSState["openFile"] });
    const view = await render(s);

    expect(view.host.textContent).toContain("draft.md");
    await click(view, "Save");

    expect(save).toHaveBeenCalledOnce();
    expect(s.editorDirtyRef.current).toBe(false);
    expect(s.setPendingLeave).toHaveBeenCalledWith(null);
    expect(pending.proceed).toHaveBeenCalledOnce();
    await close(view);
  });

  it("keeps the dialog open when no save is registered or a fake save fails", async () => {
    const missing = state(null);
    const missingView = await render(missing.s);
    expect(missingView.host.textContent).toContain("You have edits you haven't saved.");
    await click(missingView, "Save");
    expect(missingView.host.querySelector('[role="alert"]')?.textContent).toContain("can't save");
    expect(missing.pending.proceed).not.toHaveBeenCalled();
    await close(missingView);

    const failed = state(async () => {
      throw new Error("fake write failure");
    });
    const failedView = await render(failed.s);
    await click(failedView, "Save");
    expect(failedView.host.querySelector('[role="alert"]')?.textContent).toContain("didn't save");
    expect(failed.s.editorDirtyRef.current).toBe(true);
    expect(failed.pending.proceed).not.toHaveBeenCalled();
    await close(failedView);
  });

  it("lets discard proceed and lets Escape cancel without resuming", async () => {
    const discarded = state(async () => true);
    const discardView = await render(discarded.s);
    await click(discardView, "Discard changes");
    expect(discarded.pending.proceed).toHaveBeenCalledOnce();
    expect(discarded.s.editorDirtyRef.current).toBe(false);
    await close(discardView);

    const cancelled = state(async () => true);
    const cancelView = await render(cancelled.s);
    const escape = new cancelView.window.Event("keydown", { bubbles: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    await act(async () => cancelView.window.dispatchEvent(escape));
    expect(cancelled.s.setPendingLeave).toHaveBeenCalledWith(null);
    expect(cancelled.pending.proceed).not.toHaveBeenCalled();
    await close(cancelView);
  });
});
