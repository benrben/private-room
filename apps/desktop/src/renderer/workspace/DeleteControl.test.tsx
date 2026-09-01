import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../icons", () => ({
  CheckIcon: () => null,
  CloseIcon: () => null,
}));

import DeleteControl from "./DeleteControl";

const { act, createElement } = React;
const globalKeys = ["document", "window", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

type Props = React.ComponentProps<typeof DeleteControl>;

function props(overrides: Partial<Props> = {}): Props {
  return {
    k: "file-1",
    trigger: createElement("span", null, "Trash"),
    onConfirm: vi.fn(),
    title: "Delete file",
    confirmDelete: null,
    askConfirm: vi.fn(),
    cancelConfirm: vi.fn(),
    ...overrides,
  };
}

async function renderControl(initial = props()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  let current = initial;
  const update = async (next: Partial<Props>) => {
    current = { ...current, ...next };
    await act(async () => {
      root.render(createElement(DeleteControl, current));
      await Promise.resolve();
    });
  };
  await update({});
  return { document, host, root, update, current: () => current, window };
}

async function click(view: Awaited<ReturnType<typeof renderControl>>, label: string) {
  const button = view.host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`button not found: ${label}`);
  await act(async () => button.dispatchEvent(new view.window.Event("click", { bubbles: true })));
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("DeleteControl", () => {
  it("arms from the trigger, then cancels before confirming the destructive callback", async () => {
    const askConfirm = vi.fn();
    const cancelConfirm = vi.fn();
    const onConfirm = vi.fn();
    const initial = props({ askConfirm, cancelConfirm, onConfirm });
    const view = await renderControl(initial);

    await click(view, "Delete file");
    expect(askConfirm).toHaveBeenCalledWith("file-1");

    await view.update({ confirmDelete: "file-1" });
    expect(view.host.querySelector("button[aria-label='Confirm delete']")).not.toBeNull();
    await click(view, "Confirm delete");
    expect(cancelConfirm).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(cancelConfirm.mock.invocationCallOrder[0]).toBeLessThan(
      onConfirm.mock.invocationCallOrder[0],
    );

    await view.update({ confirmDelete: "file-1" });
    await click(view, "Keep");
    expect(cancelConfirm).toHaveBeenCalledTimes(2);
    expect(onConfirm).toHaveBeenCalledOnce();
    await view.update({ confirmDelete: null });
    await view.update({ confirmDelete: "file-1" });
    Object.defineProperty(view.document, "activeElement", {
      configurable: true,
      value: view.host.querySelector("button[aria-label='Confirm delete']"),
    });
    await view.update({ confirmDelete: null });
    await act(async () => view.root.unmount());
  });
});
