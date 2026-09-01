import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../icons", () => ({
  CircleCheckIcon: () => <span data-fake-icon="check" />,
}));

import RecoverySection from "./RecoverySection";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

type Props = React.ComponentProps<typeof RecoverySection>;

function props(overrides: Partial<Props> = {}): Props {
  return {
    recoveryCode: "FAKE-RECOVERY-CODE",
    recoveryCopied: false,
    setRecoveryCopied: vi.fn(),
    setRecoveryCode: vi.fn(),
    recoveryBusy: false,
    createRecoveryKey: vi.fn(),
    recoveryErr: "",
    ...overrides,
  };
}

async function render(input = props(), writeText: (text: string) => unknown = vi.fn()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  const print = vi.fn();
  Reflect.set(window, "print", print);
  for (const [key, value] of Object.entries({
    window, document, HTMLElement: window.HTMLElement, Event: window.Event,
    React, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Reflect.set(globalThis, key, value);
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { userAgent: "Vitest", clipboard: { writeText } },
  });
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(RecoverySection, input)));
  return { host, input, root, print, writeText };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim().includes(label),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

function onClick(element: Element): () => unknown {
  const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React click handler missing");
  return (element as unknown as Record<string, Record<string, () => unknown>>)[key]!.onClick!;
}

async function click(element: Element) {
  await act(async () => { onClick(element)(); });
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
  if (originalNavigatorDescriptor) Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
  else Reflect.deleteProperty(globalThis, "navigator");
});

describe("RecoverySection with fabricated clipboard and print APIs", () => {
  it("keeps a newly issued code on screen while forwarding copy, print, and done actions", async () => {
    const writeText = vi.fn();
    const view = await render(props({ recoveryErr: "fake key warning" }), writeText);
    expect(view.host.textContent).toContain("FAKE-RECOVERY-CODE");
    expect(view.host.textContent).toContain("This is shown only once");
    expect(view.host.querySelector(".gate-error")?.textContent).toBe("fake key warning");

    await click(button(view.host, "Copy code"));
    await click(button(view.host, "Print"));
    await click(button(view.host, "Done"));
    expect(view.input.setRecoveryCopied).toHaveBeenCalledWith(true);
    expect(writeText).toHaveBeenCalledWith("FAKE-RECOVERY-CODE");
    expect(view.print).toHaveBeenCalledOnce();
    expect(view.input.setRecoveryCode).toHaveBeenCalledWith(null);
    await act(async () => view.root.unmount());
  });

  it("still marks copy as complete when a fabricated clipboard is unavailable", async () => {
    const unavailable = vi.fn(() => { throw new Error("clipboard blocked"); });
    const view = await render(props({ recoveryCopied: true }), unavailable);
    expect(view.host.textContent).toContain("Copied");
    expect(view.host.querySelector("[data-fake-icon='check']")).not.toBeNull();

    await click(button(view.host, "Copied"));
    expect(view.input.setRecoveryCopied).toHaveBeenCalledWith(true);
    expect(unavailable).toHaveBeenCalledWith("FAKE-RECOVERY-CODE");
    await act(async () => view.root.unmount());
  });

  it("warns before replacing a code and keeps the replacement action disabled while busy", async () => {
    const ready = await render(props({ recoveryCode: null }));
    expect(ready.host.textContent).toContain("A new key ends the old one");
    const create = button(ready.host, "Make a new recovery key");
    expect(create.disabled).toBe(false);
    await click(create);
    expect(ready.input.createRecoveryKey).toHaveBeenCalledOnce();
    await act(async () => ready.root.unmount());

    const busy = await render(props({ recoveryCode: null, recoveryBusy: true, recoveryErr: "fake replacement failed" }));
    const creating = button(busy.host, "Creating…");
    expect(creating.disabled).toBe(true);
    expect(busy.host.querySelector(".gate-error")?.textContent).toBe("fake replacement failed");
    await act(async () => busy.root.unmount());
  });
});
