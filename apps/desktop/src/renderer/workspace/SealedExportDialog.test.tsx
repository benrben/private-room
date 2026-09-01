import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ chooseSavePath: vi.fn(), createSealedPackage: vi.fn(), passwordProblem: vi.fn(), onModalKeyDown: vi.fn() }));
vi.mock("../api", () => ({ api: { chooseSavePath: mocks.chooseSavePath, createSealedPackage: mocks.createSealedPackage } }));
vi.mock("../icons", () => ({ DownloadIcon: () => null }));
vi.mock("../rooms/constants", () => ({ MIN_PASSWORD: 12 }));
vi.mock("../rooms/passwordChange", () => ({ sealedExportPasswordProblem: mocks.passwordProblem }));
vi.mock("../settings/useFocusTrap", () => ({ useFocusTrap: () => ({ modalRef: { current: null }, onModalKeyDown: mocks.onModalKeyDown }) }));

import SealedExportDialog from "./SealedExportDialog";

const { act, createElement } = React;
const globalKeys = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
type DialogProps = React.ComponentProps<typeof SealedExportDialog>;

function props(overrides: Partial<DialogProps> = {}): DialogProps {
  return { onClose: vi.fn(), pushToast: vi.fn(), ...overrides };
}

async function flush() {
  await act(async () => {
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  });
}

async function render(dialogProps: DialogProps) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({ window, document, navigator: window.navigator, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, Event: window.Event, React, IS_REACT_ACT_ENVIRONMENT: true })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(SealedExportDialog, dialogProps)));
  await flush();
  return { host, root, window };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => node.dispatchEvent(new window.Event("click", { bubbles: true })));
  await flush();
}

beforeEach(() => {
  mocks.chooseSavePath.mockReset();
  mocks.createSealedPackage.mockReset();
  mocks.passwordProblem.mockReset();
  mocks.onModalKeyDown.mockReset();
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("SealedExportDialog", () => {
  it("closes through Cancel, ignores cancellation while busy, and forwards Escape to the focus trap", async () => {
    let finishSave: ((value: { fileCount: number }) => void) | null = null;
    mocks.chooseSavePath.mockResolvedValueOnce("/tmp/room.arcelle");
    mocks.createSealedPackage.mockImplementationOnce(
      () => new Promise<{ fileCount: number }>((resolve) => { finishSave = resolve; }),
    );
    const dialogProps = props();
    const view = await render(dialogProps);
    const card = view.host.querySelector('[role="dialog"]');
    if (!card) throw new Error("dialog card missing");
    const stopPropagation = vi.fn();
    reactProps<{ onKeyDown: (event: unknown) => void }>(card).onKeyDown({
      key: "Escape",
      stopPropagation,
    });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(mocks.onModalKeyDown).toHaveBeenCalledOnce();

    await click(button(view.host, "Choose location"), view.window);
    const cancel = button(view.host, "Cancel");
    expect(cancel.disabled).toBe(true);
    reactProps<{ onClick: () => void }>(cancel).onClick();
    expect(dialogProps.onClose).not.toHaveBeenCalled();

    await act(async () => finishSave?.({ fileCount: 1 }));
    expect(dialogProps.onClose).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());

    const idleProps = props();
    const idleView = await render(idleProps);
    await click(button(idleView.host, "Cancel"), idleView.window);
    expect(idleProps.onClose).toHaveBeenCalledOnce();
    await act(async () => idleView.root.unmount());
  });

  it("creates a room-password backup after the mocked destination is chosen", async () => {
    mocks.chooseSavePath.mockResolvedValueOnce("/tmp/room.arcelle");
    mocks.createSealedPackage.mockResolvedValueOnce({ fileCount: 1 });
    const dialogProps = props();
    const view = await render(dialogProps);
    await click(button(view.host, "Choose location"), view.window);
    expect(mocks.createSealedPackage).toHaveBeenCalledWith("/tmp/room.arcelle", null);
    expect(dialogProps.pushToast).toHaveBeenCalledWith("success", "Sealed 1 file into the backup.");
    expect(dialogProps.onClose).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });

  it("shows alternate-password validation before asking for a destination", async () => {
    mocks.passwordProblem.mockReturnValueOnce("Password needs more characters.");
    const view = await render(props());
    const alternate = view.host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
    if (!alternate) throw new Error("alternate password radio missing");
    await act(async () => reactProps<{ onChange: () => void }>(alternate).onChange());
    await flush();
    expect(view.host.textContent).toContain("Backup password");
    await click(button(view.host, "Choose location"), view.window);
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("more characters");
    expect(mocks.chooseSavePath).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
  });

  it("stays open on cancelled destination and reports mocked save failures", async () => {
    mocks.chooseSavePath.mockResolvedValueOnce(null);
    const cancelled = props();
    let view = await render(cancelled);
    await click(button(view.host, "Choose location"), view.window);
    expect(mocks.createSealedPackage).not.toHaveBeenCalled();
    expect(cancelled.onClose).not.toHaveBeenCalled();
    await act(async () => view.root.unmount());
    mocks.chooseSavePath.mockRejectedValueOnce(new Error("disk unavailable"));
    const failed = props();
    view = await render(failed);
    await click(button(view.host, "Choose location"), view.window);
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("disk unavailable");
    expect(failed.pushToast).toHaveBeenCalledWith("error", "Error: disk unavailable");
    await act(async () => view.root.unmount());
  });
});
