import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFocusTrap } from "./useFocusTrap";

const globalKeys = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type FocusTrap = ReturnType<typeof useFocusTrap>;

let trap: FocusTrap | null = null;

function FocusTrapProbe({ onClose, controls }: { onClose: () => void; controls: boolean }) {
  trap = useFocusTrap(onClose);
  return createElement(
    "div",
    { ref: trap.modalRef, tabIndex: -1 },
    controls
      ? ["first", "middle", "last"].map((id) =>
          createElement("button", { id, key: id }, id),
        )
      : null,
  );
}

function currentTrap(): FocusTrap {
  if (!trap) throw new Error("Focus trap hook has not rendered.");
  return trap;
}

function keyEvent(key: string, shiftKey = false) {
  return { key, shiftKey, preventDefault: vi.fn() } as unknown as React.KeyboardEvent;
}

async function render(controls = true) {
  const parsed = parseHTML("<html><body><button id='trigger'>Open settings</button><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  let active: HTMLElement | null = null;
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => active,
  });
  Object.defineProperty(window.HTMLElement.prototype, "focus", {
    configurable: true,
    value(this: HTMLElement) {
      active = this;
    },
  });
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  const trigger = document.getElementById("trigger") as HTMLElement | null;
  if (!host || !trigger) throw new Error("Focus trap test fixture missing.");
  const root = createRoot(host);
  const onClose = vi.fn();
  trigger.focus();
  await act(async () => {
    root.render(createElement(FocusTrapProbe, { onClose, controls }));
    await Promise.resolve();
  });
  const modal = currentTrap().modalRef.current;
  if (!modal) throw new Error("Focus trap modal missing.");
  return {
    active: () => active,
    buttons: ["first", "middle", "last"].map((id) => document.getElementById(id) as HTMLElement | null),
    close: async () => act(async () => root.unmount()),
    modal,
    onClose,
    trigger,
  };
}

afterEach(() => {
  trap = null;
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("useFocusTrap", () => {
  it("moves focus into the modal and restores its opening trigger", async () => {
    const view = await render();
    const [first] = view.buttons;
    expect(view.active()).toBe(first);

    await view.close();
    expect(view.active()).toBe(view.trigger);
  });

  it("cycles Tab only when focus reaches a modal boundary", async () => {
    const view = await render();
    const [first, middle, last] = view.buttons;
    if (!first || !middle || !last) throw new Error("Focus controls missing.");

    first.focus();
    const backward = keyEvent("Tab", true);
    currentTrap().onModalKeyDown(backward);
    expect(backward.preventDefault).toHaveBeenCalledOnce();
    expect(view.active()).toBe(last);

    last.focus();
    const forward = keyEvent("Tab");
    currentTrap().onModalKeyDown(forward);
    expect(forward.preventDefault).toHaveBeenCalledOnce();
    expect(view.active()).toBe(first);

    middle.focus();
    const middleTab = keyEvent("Tab");
    currentTrap().onModalKeyDown(middleTab);
    expect(middleTab.preventDefault).not.toHaveBeenCalled();
    expect(view.active()).toBe(middle);
    await view.close();
  });

  it("keeps focus in the modal for outside focus, empty content, and a declined close", async () => {
    const view = await render();
    const [first, middle, last] = view.buttons;
    if (!first || !middle || !last) throw new Error("Focus controls missing.");

    view.modal.focus();
    const fromContainer = keyEvent("Tab", true);
    currentTrap().onModalKeyDown(fromContainer);
    expect(fromContainer.preventDefault).toHaveBeenCalledOnce();
    expect(view.active()).toBe(last);

    view.trigger.focus();
    const fromWorkspace = keyEvent("Tab");
    currentTrap().onModalKeyDown(fromWorkspace);
    expect(fromWorkspace.preventDefault).toHaveBeenCalledOnce();
    expect(view.active()).toBe(first);

    middle.focus();
    currentTrap().refocusModal();
    expect(view.active()).toBe(middle);
    view.trigger.focus();
    currentTrap().refocusModal();
    expect(view.active()).toBe(view.modal);

    const escape = keyEvent("Escape");
    currentTrap().onModalKeyDown(escape);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(view.onClose).toHaveBeenCalledOnce();

    const ignored = keyEvent("Enter");
    currentTrap().onModalKeyDown(ignored);
    expect(ignored.preventDefault).not.toHaveBeenCalled();
    await view.close();

    const empty = await render(false);
    const emptyTab = keyEvent("Tab");
    currentTrap().onModalKeyDown(emptyTab);
    expect(emptyTab.preventDefault).toHaveBeenCalledOnce();
    expect(empty.active()).toBe(empty.modal);
    await empty.close();
  });
});
