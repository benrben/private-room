import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomServerStatus } from "./types";

vi.mock("../icons", () => ({ CircleCheckIcon: () => null }));

import RoomServerSection from "./RoomServerSection";

const { act, createElement } = React;
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
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

type RoomServerProps = React.ComponentProps<typeof RoomServerSection>;

function leash(overrides: Partial<RoomServerStatus> = {}): RoomServerStatus {
  return {
    running: true,
    url: "http://127.0.0.1:17872/mcp",
    config: '{"mcpServers":{"room":{}}}',
    scope: "files",
    stable: true,
    allowCloud: false,
    ...overrides,
  };
}

function props(overrides: Partial<RoomServerProps> = {}): RoomServerProps {
  return {
    leash: leash(),
    leashBusy: false,
    toggleLeash: vi.fn(),
    allowCloud: false,
    toggleAllowCloud: vi.fn(),
    scope: "files",
    changeScope: vi.fn(),
    regenerateToken: vi.fn(),
    copyLeashConfig: vi.fn(),
    leashCopied: false,
    leashErr: "",
    AlertIcon: () => null,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(sectionProps: RoomServerProps) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: { userAgent: "Vitest" },
  });
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "HTMLInputElement", window.HTMLInputElement);
  Reflect.set(globalThis, "HTMLTextAreaElement", window.HTMLTextAreaElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(RoomServerSection, sectionProps)),
  );
  await flush();
  return { host, root, window };
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) =>
    name.startsWith("__reactProps"),
  );
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim().includes(label),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

async function change(node: Element, checked: boolean) {
  await act(async () =>
    reactProps<{
      onChange: (event: { target: { checked: boolean } }) => void;
    }>(node).onChange({ target: { checked } }),
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

describe("RoomServerSection", () => {
  it("keeps a stopped room private and surfaces a server error", async () => {
    const sectionProps = props({
      leash: leash({ running: false }),
      leashErr: "Could not bind the room server.",
    });
    const view = await render(sectionProps);

    expect(view.host.textContent).toContain("The room is not shared.");
    expect(view.host.textContent).not.toContain("Access level");
    expect(view.host.textContent).toContain("Could not bind the room server.");
    const toggle = view.host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!toggle) throw new Error("room toggle missing");
    await change(toggle, true);
    expect(sectionProps.toggleLeash).toHaveBeenCalledOnce();

    await act(async () => view.root.unmount());
  });

  it("wires file-only scope controls, configuration actions, and cloud consent", async () => {
    const sectionProps = props({ allowCloud: true });
    const view = await render(sectionProps);

    expect(view.host.textContent).toContain("Files only");
    expect(view.host.textContent).toContain("Cloud AI clients may connect.");
    expect(view.host.textContent).toContain("Only apps you paste this into");
    expect(view.host.textContent).not.toContain("Regenerate token");
    const radios = view.host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    const cloudToggle = view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
    if (radios.length !== 2 || !cloudToggle) throw new Error("scope controls missing");
    await change(radios[1]!, true);
    await change(cloudToggle, false);
    await click(button(view.host, "Copy config"), view.window);
    expect(sectionProps.changeScope).toHaveBeenCalledWith("full");
    expect(sectionProps.toggleAllowCloud).toHaveBeenCalledWith(false);
    expect(sectionProps.copyLeashConfig).toHaveBeenCalledOnce();

    const address = [...view.host.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.value === sectionProps.leash.url,
    );
    const config = view.host.querySelector<HTMLTextAreaElement>("textarea");
    if (!address || !config) throw new Error("connection fields missing");
    const selectAddress = vi.fn();
    const selectConfig = vi.fn();
    await act(async () =>
      reactProps<{ onFocus: (event: { target: { select: () => void } }) => void }>(
        address,
      ).onFocus({ target: { select: selectAddress } }),
    );
    await act(async () =>
      reactProps<{ onFocus: (event: { target: { select: () => void } }) => void }>(
        config,
      ).onFocus({ target: { select: selectConfig } }),
    );
    expect(selectAddress).toHaveBeenCalledOnce();
    expect(selectConfig).toHaveBeenCalledOnce();

    await act(async () => view.root.unmount());
  });

  it("shows full-scope consequences and unstable address recovery without cloud controls", async () => {
    const sectionProps = props({
      leash: leash({ scope: "full", stable: false }),
      scope: "full",
      leashCopied: true,
      leashBusy: false,
      allowCloud: true,
    });
    const view = await render(sectionProps);

    expect(view.host.textContent).toContain("external agent at this level");
    expect(view.host.textContent).toContain("fixed Leash port (17872)");
    expect(view.host.textContent).toContain("self-configure from");
    expect(view.host.textContent).toContain("Copied");
    expect(
      [...view.host.querySelectorAll("label")].some(
        (label) => label.textContent?.trim() === "Allow cloud AI clients",
      ),
    ).toBe(false);
    const tokenButton = button(view.host, "Regenerate token");
    expect(tokenButton.disabled).toBe(false);
    await click(tokenButton, view.window);
    expect(sectionProps.regenerateToken).toHaveBeenCalledOnce();
    expect(view.host.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);

    await act(async () => view.root.unmount());
  });

  it("describes local-only and stable configurations", async () => {
    const localView = await render(props());
    expect(localView.host.textContent).toContain("Local apps only.");
    await act(async () => localView.root.unmount());

    const stableView = await render(
      props({
        leash: leash({ scope: "full", stable: true }),
        scope: "full",
      }),
    );
    expect(stableView.host.textContent).toContain(
      "This address and config survive restarts.",
    );
    expect(stableView.host.textContent).not.toContain("fixed Leash port");
    await act(async () => stableView.root.unmount());
  });
});
