import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomRole } from "../apiTypes";
import { CreateScreen } from "./CreateScreen";

const { act, createElement } = React;
const keys = [
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
const originals = Object.fromEntries(
  keys.map((key) => [key, Reflect.get(globalThis, key)]),
);

type ScreenProps = React.ComponentProps<typeof CreateScreen>;
const role: RoomRole = {
  id: "reviewer",
  name: "Reviewer",
  blurb: "Reviews every draft.",
  instructions: "Review drafts.",
  prompts: [],
  commands: [],
};

function props(overrides: Partial<ScreenProps> = {}): ScreenProps {
  return {
    roomName: "Journal",
    setRoomName: vi.fn(),
    templateKey: "blank",
    setTemplateKey: vi.fn(),
    roles: [role],
    roleId: "reviewer",
    setRoleId: vi.fn(),
    password: "Password 123!",
    setPassword: vi.fn(),
    confirm: "Password 123!",
    setConfirm: vi.fn(),
    error: "Existing setup error.",
    setError: vi.fn(),
    busy: false,
    onSubmit: vi.fn(),
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
    HTMLSelectElement: window.HTMLSelectElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(CreateScreen, screenProps)));
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

async function change(node: Element, value: string) {
  await act(async () =>
    reactProps<{ onChange: (event: { target: { value: string } }) => void }>(
      node,
    ).onChange({ target: { value } }),
  );
  await flush();
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () =>
    node.dispatchEvent(new window.Event("click", { bubbles: true })),
  );
  await flush();
}

afterEach(() => {
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("CreateScreen", () => {
  it("wires the room, template, role, password, submit, and back controls", async () => {
    const screenProps = props({ password: "short", confirm: "different" });
    const view = await render(screenProps);
    expect(view.host.textContent).toContain("Name your room");
    expect(view.host.textContent).toContain("Reviews every draft.");
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain(
      "Existing setup error.",
    );
    const inputs = view.host.querySelectorAll<HTMLInputElement>("input");
    const select = view.host.querySelector<HTMLSelectElement>("select");
    if (inputs.length !== 3 || !select)
      throw new Error("create controls missing");
    expect(inputs[1]!.getAttribute("aria-invalid")).toBe("true");
    expect(inputs[2]!.getAttribute("aria-invalid")).toBe("true");
    expect(view.host.textContent).not.toContain("Passwords do not match.");
    await change(inputs[0]!, "Work");
    await change(inputs[1]!, "Password 123!");
    await change(inputs[2]!, "Password 123!");
    await change(select, "reviewer");
    await click(button(view.host, "Legal"), view.window);
    expect(screenProps.setRoomName).toHaveBeenCalledWith("Work");
    expect(screenProps.setPassword).toHaveBeenCalledWith("Password 123!");
    expect(screenProps.setConfirm).toHaveBeenCalledWith("Password 123!");
    expect(screenProps.setRoleId).toHaveBeenCalledWith("reviewer");
    expect(screenProps.setTemplateKey).toHaveBeenCalledWith("legal");
    expect(screenProps.setError).toHaveBeenCalledTimes(2);
    const form = view.host.querySelector("form");
    if (!form) throw new Error("create form missing");
    const submit = new view.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => form.dispatchEvent(submit));
    expect(submit.defaultPrevented).toBe(true);
    expect(screenProps.onSubmit).toHaveBeenCalledOnce();
    await click(button(view.host, "Back"), view.window);
    expect(screenProps.onBack).toHaveBeenCalledOnce();
    await act(async () => view.root.unmount());
  });

  it("shows local validation and keeps creation unavailable while invalid or busy", async () => {
    const invalid = await render(
      props({
        error: "",
        password: "Password 123!",
        confirm: "different",
        roles: [],
      }),
    );
    expect(invalid.host.textContent).toContain("Passwords do not match.");
    expect(invalid.host.querySelector("select")).toBeNull();
    expect(button(invalid.host, "Create & Enter").disabled).toBe(true);
    await act(async () => invalid.root.unmount());

    const busy = await render(
      props({
        busy: true,
        error: "",
        password: "Password 123!",
        confirm: "Password 123!",
      }),
    );
    expect(button(busy.host, "Creating").disabled).toBe(true);
    expect(busy.host.textContent).toContain("There is no password reset");
    await act(async () => busy.root.unmount());
  });

  it("keeps feedback reserved until a password is entered", async () => {
    const view = await render(
      props({ password: "", confirm: "", error: "", roles: [] }),
    );
    expect(view.host.querySelector(".pw-feedback.reserved")).not.toBeNull();
    expect(button(view.host, "Create & Enter").disabled).toBe(true);
    await act(async () => view.root.unmount());
  });
});
