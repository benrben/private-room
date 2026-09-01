import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../icons", () => ({ CircleCheckIcon: () => null }));

import PrivacySection from "./PrivacySection";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);

type PrivacyProps = React.ComponentProps<typeof PrivacySection>;

function props(overrides: Partial<PrivacyProps> = {}): PrivacyProps {
  return {
    autolock: "15",
    changeAutolock: vi.fn(),
    pwCurrent: "current",
    setPwCurrent: vi.fn(),
    pwNew: "New password 123!",
    setPwNew: vi.fn(),
    pwRepeat: "New password 123!",
    setPwRepeat: vi.fn(),
    pwError: "Current password was not accepted.",
    pwSaved: true,
    changePassword: vi.fn(),
    pwRecoveryCode: "RECOVERY-KEY",
    setPwRecoveryCode: vi.fn(),
    pwRecoveryCopied: false,
    setPwRecoveryCopied: vi.fn(),
    touchIdOn: true,
    toggleTouchId: vi.fn(),
    touchIdErr: "Touch ID is unavailable.",
    chooseDupDest: vi.fn(),
    dupDest: "/Rooms/Copy.room",
    dupPassword: "Copy password 123!",
    setDupPassword: vi.fn(),
    dupRepeat: "Copy password 123!",
    setDupRepeat: vi.fn(),
    dupError: "Choose a different destination.",
    duplicate: vi.fn(),
    dupDone: true,
    compactMsg: "This cannot be undone.",
    compactArmed: false,
    setCompactArmed: vi.fn(),
    compact: vi.fn(),
    compacting: false,
    setCompactMsg: vi.fn(),
    compactErr: "Compact failed.",
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(sectionProps: PrivacyProps, clipboard = vi.fn()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  const print = vi.fn();
  Reflect.set(window, "print", print);
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { userAgent: "Vitest", clipboard: { writeText: clipboard } },
  });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "HTMLSelectElement", window.HTMLSelectElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(PrivacySection, sectionProps)),
  );
  await flush();
  return { host, root, window, print, clipboard };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim().includes(label),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) =>
    name.startsWith("__reactProps"),
  );
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function change(node: Element, value: string | boolean) {
  await act(async () =>
    reactProps<{
      onChange: (event: {
        target: { value: string; checked: boolean };
      }) => void;
    }>(node).onChange({
      target: { value: String(value), checked: Boolean(value) },
    }),
  );
  await flush();
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => {
    node.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  await flush();
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (key === "navigator") {
      Reflect.deleteProperty(globalThis, key);
      if (originalNavigatorDescriptor)
        Object.defineProperty(globalThis, key, originalNavigatorDescriptor);
      continue;
    }
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("PrivacySection", () => {
  it("wires password, Touch ID, duplicate, auto-lock, recovery, and compact controls", async () => {
    const setCompactMsg = vi.fn();
    const setCompactArmed = vi.fn();
    const sectionProps = props({ setCompactMsg, setCompactArmed });
    const clipboard = vi.fn();
    const view = await render(sectionProps, clipboard);
    expect(view.host.textContent).toContain("There is no password reset");
    expect(view.host.textContent).toContain("Password changed");
    expect(view.host.textContent).toContain(
      "This room can be unlocked with Touch ID.",
    );
    expect(view.host.textContent).toContain("Copy.room");
    expect(view.host.textContent).toContain("Duplicated");
    expect(view.host.textContent).toContain("This cannot be undone.");

    const select = view.host.querySelector<HTMLSelectElement>("select");
    const inputs = view.host.querySelectorAll<HTMLInputElement>("input");
    if (!select || inputs.length < 6)
      throw new Error("settings controls missing");
    await change(select, "60");
    await change(inputs[0]!, "current next");
    await change(inputs[1]!, "Newer password 123!");
    await change(inputs[2]!, "Newer password 123!");
    await change(inputs[3]!, false);
    await change(inputs[4]!, "Copy newer 123!");
    await change(inputs[5]!, "Copy newer 123!");
    expect(sectionProps.changeAutolock).toHaveBeenCalledWith("60");
    expect(sectionProps.setPwCurrent).toHaveBeenCalledWith("current next");
    expect(sectionProps.setPwNew).toHaveBeenCalledWith("Newer password 123!");
    expect(sectionProps.setPwRepeat).toHaveBeenCalledWith(
      "Newer password 123!",
    );
    expect(sectionProps.toggleTouchId).toHaveBeenCalledOnce();
    expect(sectionProps.setDupPassword).toHaveBeenCalledWith("Copy newer 123!");
    expect(sectionProps.setDupRepeat).toHaveBeenCalledWith("Copy newer 123!");

    await click(button(view.host, "Password changed"), view.window);
    await click(button(view.host, "Choose destination"), view.window);
    await click(button(view.host, "Duplicate"), view.window);
    await click(button(view.host, "Copy code"), view.window);
    await click(button(view.host, "Print"), view.window);
    await click(button(view.host, "Done"), view.window);
    await click(button(view.host, "Compact room now"), view.window);
    expect(sectionProps.changePassword).toHaveBeenCalledOnce();
    expect(sectionProps.chooseDupDest).toHaveBeenCalledOnce();
    expect(sectionProps.duplicate).toHaveBeenCalledOnce();
    expect(sectionProps.setPwRecoveryCopied).toHaveBeenCalledWith(true);
    expect(clipboard).toHaveBeenCalledWith("RECOVERY-KEY");
    expect(view.print).toHaveBeenCalledOnce();
    expect(sectionProps.setPwRecoveryCode).toHaveBeenCalledWith(null);
    expect(sectionProps.setCompactMsg).toHaveBeenCalledWith("");
    expect(sectionProps.setCompactArmed).toHaveBeenCalledWith(true);
    expect(setCompactMsg.mock.invocationCallOrder[0]).toBeLessThan(
      setCompactArmed.mock.invocationCallOrder[0],
    );
    await act(async () => view.root.unmount());
  });

  it("confirms compact in the required state order and permits cancellation", async () => {
    const setCompactArmed = vi.fn();
    const compact = vi.fn();
    const sectionProps = props({
      compactArmed: true,
      compactMsg: "Confirm once.",
      setCompactArmed,
      compact,
    });
    const view = await render(sectionProps);
    await click(button(view.host, "Confirm compact"), view.window);
    expect(sectionProps.setCompactArmed).toHaveBeenCalledWith(false);
    expect(sectionProps.compact).toHaveBeenCalledOnce();
    expect(setCompactArmed.mock.invocationCallOrder[0]).toBeLessThan(
      compact.mock.invocationCallOrder[0],
    );
    await click(button(view.host, "Cancel"), view.window);
    expect(sectionProps.setCompactArmed).toHaveBeenCalledTimes(2);
    await act(async () => view.root.unmount());
  });

  it("retains the unconfigured labels and empty-state guards", async () => {
    const view = await render(
      props({
        pwNew: "",
        pwSaved: false,
        pwError: "",
        pwRecoveryCopied: true,
        touchIdOn: false,
        touchIdErr: "",
        dupDest: "",
        dupPassword: "",
        dupDone: false,
        dupError: "",
        compactMsg: "",
        compactErr: "",
      }),
    );
    expect(view.host.textContent).toContain("Change password");
    expect(view.host.textContent).toContain("Copied");
    expect(view.host.textContent).toContain(
      "Unlock this room with a fingerprint.",
    );
    expect(view.host.querySelector(".dup-dest")).toBeNull();
    expect(view.host.querySelectorAll(".pw-feedback.reserved")).toHaveLength(1);
    expect(button(view.host, "Duplicate").textContent).toContain("Duplicate");
    await act(async () => view.root.unmount());

    const noRecoveryKey = await render(props({ pwRecoveryCode: null }));
    expect(noRecoveryKey.host.querySelector(".recovery-sheet")).toBeNull();
    await act(async () => noRecoveryKey.root.unmount());
  });

  it("keeps compact unavailable during progress and tolerates synchronous clipboard failure", async () => {
    const clipboard = vi.fn(() => {
      throw new Error("clipboard unavailable");
    });
    const sectionProps = props({ compactArmed: true, compacting: true });
    const view = await render(sectionProps, clipboard);
    expect(button(view.host, "Compacting").disabled).toBe(true);
    expect(button(view.host, "Cancel").disabled).toBe(true);
    await click(button(view.host, "Copy code"), view.window);
    expect(sectionProps.setPwRecoveryCopied).toHaveBeenCalledWith(true);
    expect(clipboard).toHaveBeenCalledWith("RECOVERY-KEY");
    await act(async () => view.root.unmount());
  });
});
