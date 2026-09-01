import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./RecoveryKeyIcon", () => ({ RecoveryKeyIcon: () => null }));

import { UnlockScreen } from "./UnlockScreen";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "Event",
  "React",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = Object.fromEntries(
  globalKeys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type ScreenProps = React.ComponentProps<typeof UnlockScreen>;

function props(overrides: Partial<ScreenProps> = {}): ScreenProps {
  return {
    path: "/Rooms/Journal.txt",
    recoveryMode: false,
    canTouchId: false,
    hasRecovery: false,
    busy: false,
    password: "",
    setPassword: vi.fn(),
    recoveryInput: "",
    setRecoveryInput: vi.fn(),
    error: "",
    setError: vi.fn(),
    onUnlock: vi.fn(),
    onRecoveryUnlock: vi.fn(),
    onTouchId: vi.fn(),
    onConvertLegacy: vi.fn(),
    onInspectSealed: vi.fn(),
    onEnterRecoveryMode: vi.fn(),
    onExitRecoveryMode: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(screenProps: ScreenProps) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(UnlockScreen, screenProps)));
  await flush();
  return { host, root, window };
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

async function change(input: HTMLInputElement, value: string) {
  await act(async () =>
    reactProps<{ onChange: (event: { target: { value: string } }) => void }>(
      input,
    ).onChange({ target: { value } }),
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
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("UnlockScreen", () => {
  it("submits password unlocks and clears a displayed error when typing", async () => {
    const screenProps = props({
      password: "old secret",
      error: "That password did not unlock this room.",
      canTouchId: true,
      hasRecovery: true,
    });
    const view = await render(screenProps);
    expect(view.host.textContent).toContain("Unlock Journal.txt");
    expect(view.host.textContent).toContain("normal files in this workspace");
    const input = view.host.querySelector<HTMLInputElement>(
      'input[placeholder="Password"]',
    );
    if (!input) throw new Error("password input missing");
    expect(input.type).toBe("password");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain(
      "That password did not unlock this room.",
    );
    await change(input, "next secret");
    expect(screenProps.setPassword).toHaveBeenCalledWith("next secret");
    expect(screenProps.setError).toHaveBeenCalledWith("");
    const form = view.host.querySelector("form");
    if (!form) throw new Error("password form missing");
    const submit = new view.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => form.dispatchEvent(submit));
    expect(submit.defaultPrevented).toBe(true);
    expect(screenProps.onUnlock).toHaveBeenCalledOnce();
    await click(button(view.host, "Use Touch ID"), view.window);
    await click(button(view.host, "Forgot password"), view.window);
    await click(button(view.host, "Back"), view.window);
    expect(screenProps.onTouchId).toHaveBeenCalledOnce();
    expect(screenProps.onEnterRecoveryMode).toHaveBeenCalledOnce();
    expect(screenProps.onBack).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });

  it("keeps legacy room actions separate from normal workspace guidance", async () => {
    const screenProps = props({ path: "/Rooms/Old.ARCELLE" });
    const view = await render(screenProps);
    expect(view.host.textContent).not.toContain(
      "normal files in this workspace",
    );
    await click(button(view.host, "Convert legacy room"), view.window);
    await click(button(view.host, "Inspect sealed backup"), view.window);
    expect(screenProps.onConvertLegacy).toHaveBeenCalledOnce();
    expect(screenProps.onInspectSealed).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });

  it("marks every loading action unavailable without replacing its route", async () => {
    const passwordView = await render(
      props({
        path: "/Rooms/Old.arcelle",
        busy: true,
        canTouchId: true,
      }),
    );
    expect(button(passwordView.host, "Unlocking").disabled).toBe(true);
    expect(button(passwordView.host, "Use Touch ID").disabled).toBe(true);
    expect(button(passwordView.host, "Convert legacy room").disabled).toBe(
      true,
    );
    expect(button(passwordView.host, "Inspect sealed backup").disabled).toBe(
      true,
    );
    await act(async () => passwordView.root.unmount());

    const recoveryView = await render(
      props({ recoveryMode: true, busy: true, recoveryInput: "READY" }),
    );
    const recoveryInput = recoveryView.host.querySelector<HTMLInputElement>(
      'input[placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"]',
    );
    if (!recoveryInput) throw new Error("recovery input missing");
    expect(recoveryInput.className).not.toContain("invalid");
    expect(button(recoveryView.host, "Unlocking").disabled).toBe(true);
    await act(async () => recoveryView.root.unmount());
  });

  it("uppercases recovery input, preserves its accessibility state, and submits the recovery path", async () => {
    const screenProps = props({
      path: "/Rooms/Journal.roomai",
      recoveryMode: true,
      recoveryInput: "  ",
      error: "Recovery code rejected",
    });
    const view = await render(screenProps);
    const input = view.host.querySelector<HTMLInputElement>(
      'input[placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"]',
    );
    if (!input) throw new Error("recovery input missing");
    expect(
      reactProps<{
        autoCapitalize: string;
        autoCorrect: string;
        spellCheck: boolean;
      }>(input),
    ).toMatchObject({
      autoCapitalize: "characters",
      autoCorrect: "off",
      spellCheck: false,
    });
    expect(input.className).toContain("invalid");
    expect(button(view.host, "Unlock with code").disabled).toBe(true);
    await change(input, "code-a1");
    expect(screenProps.setRecoveryInput).toHaveBeenCalledWith("CODE-A1");
    expect(screenProps.setError).toHaveBeenCalledWith("");
    const form = view.host.querySelector("form");
    if (!form) throw new Error("recovery form missing");
    await act(async () =>
      form.dispatchEvent(new view.window.Event("submit", { bubbles: true })),
    );
    expect(screenProps.onRecoveryUnlock).toHaveBeenCalledOnce();
    await click(button(view.host, "Use password instead"), view.window);
    expect(screenProps.onExitRecoveryMode).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });
});
