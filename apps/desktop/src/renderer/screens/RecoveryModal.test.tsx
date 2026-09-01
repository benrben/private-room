import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dialog = vi.hoisted(() => ({ confirm: vi.fn() }));
const trap = vi.hoisted(() => ({ onModalKeyDown: vi.fn() }));

vi.mock("../platform", () => ({ confirm: dialog.confirm }));
vi.mock("../settings/useFocusTrap", () => ({
  useFocusTrap: () => ({ modalRef: { current: null }, onModalKeyDown: trap.onModalKeyDown }),
}));
vi.mock("../icons", () => ({ CircleCheckIcon: () => null }));

import { RecoveryModal } from "./RecoveryModal";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function props(overrides: Partial<React.ComponentProps<typeof RecoveryModal>> = {}) {
  return {
    recoveryCode: "violet-planet-forest",
    recoveryCopied: false,
    setRecoveryCopied: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

async function render(input = props()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
  Object.defineProperty(window, "print", { configurable: true, value: vi.fn() });
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { clipboard, userAgent: "Vitest" },
  });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(RecoveryModal, input));
    await Promise.resolve();
  });
  return { clipboard, host, input, root, window };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().includes(label));
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
  await act(async () => {
    view.root.unmount();
    await Promise.resolve();
  });
}

beforeEach(() => {
  dialog.confirm.mockReset().mockResolvedValue(false);
  trap.onModalKeyDown.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (key === "navigator") {
      Reflect.deleteProperty(globalThis, key);
      if (originalNavigatorDescriptor) Object.defineProperty(globalThis, key, originalNavigatorDescriptor);
      continue;
    }
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("RecoveryModal", () => {
  it("marks a recovery code copied only after the clipboard write succeeds", async () => {
    const view = await render();
    let resolveWrite: (() => void) | undefined;
    view.clipboard.writeText.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveWrite = resolve;
    }));
    await click(view, "Copy code");

    expect(view.clipboard.writeText).toHaveBeenCalledWith("violet-planet-forest");
    expect(view.input.setRecoveryCopied).not.toHaveBeenCalled();
    if (!resolveWrite) throw new Error("clipboard write did not start");
    await act(async () => {
      resolveWrite?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.input.setRecoveryCopied).toHaveBeenCalledWith(true);
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    await close(view);
  });

  it("keeps the one-time recovery code visible when copying fails", async () => {
    const view = await render();
    view.clipboard.writeText.mockRejectedValueOnce(new Error("clipboard denied"));
    await click(view, "Copy code");

    expect(view.input.setRecoveryCopied).not.toHaveBeenCalled();
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't copy");
    await close(view);
  });

  it.each([
    { answer: false, label: "declined" },
    { answer: true, label: "confirmed" },
  ])("uses the skip confirmation before dismissing an uncopied code when it is $label", async ({ answer }) => {
    dialog.confirm.mockResolvedValueOnce(answer);
    const view = await render();
    await click(view, "Skip for now");

    expect(dialog.confirm).toHaveBeenCalledWith(
      expect.stringContaining("shown once"),
      expect.objectContaining({ kind: "warning", okLabel: "Skip anyway" }),
    );
    expect(view.input.onDismiss).toHaveBeenCalledTimes(answer ? 1 : 0);
    await close(view);
  });

  it("dismisses an already copied code and prints only when explicitly requested", async () => {
    const view = await render(props({ recoveryCopied: true }));
    await click(view, "Print / Save as PDF");
    expect(view.window.print).toHaveBeenCalledOnce();

    await click(view, "Skip for now");
    expect(dialog.confirm).not.toHaveBeenCalled();
    expect(view.input.onDismiss).toHaveBeenCalledOnce();
    await close(view);
  });

  it("does not attempt to copy an empty recovery code", async () => {
    const view = await render(props({ recoveryCode: "" }));
    await click(view, "Copy code");

    expect(view.clipboard.writeText).not.toHaveBeenCalled();
    expect(view.input.setRecoveryCopied).not.toHaveBeenCalled();
    await close(view);
  });
});
