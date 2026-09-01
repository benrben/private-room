import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ trustState: vi.fn() }));

vi.mock("../icons", () => ({
  CloudIcon: () => null,
  CloudOffIcon: () => null,
  DatabaseIcon: () => null,
  ShieldIcon: () => null,
}));
vi.mock("../workspace/markup", () => ({ trustState: bridge.trustState }));

import StatusBar from "./StatusBar";

const { act, createElement } = React;

const globalKeys = [
  "document",
  "window",
  "navigator",
  "Node",
  "HTMLElement",
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

function props(overrides: Record<string, unknown> = {}) {
  return {
    layout: {} as never,
    fileCount: 2,
    cloud: false,
    engineLabel: "Local engine",
    protectedOn: true,
    onOpenPrivacy: vi.fn(),
    webOn: false,
    mcpToolCount: 0,
    runningJobs: 0,
    pendingApprovals: 0,
    onShowActivity: vi.fn(),
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderStatus(
  statusProps = props(),
  online: boolean | undefined = true,
) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value:
      online === undefined
        ? { userAgent: "Vitest" }
        : { onLine: online, userAgent: "Vitest" },
  });
  Reflect.set(globalThis, "Node", window.Node);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(StatusBar, statusProps as never)),
  );
  await flush();
  return { host, root, statusProps, window };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim().includes(label),
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => {
    node.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  bridge.trustState.mockReset();
  bridge.trustState.mockReturnValue({
    tone: "good",
    label: "Protected cloud",
    title: "Protected details leave the Mac.",
  });
});

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

describe("StatusBar", () => {
  it("shows local status, correct file grammar, and opens privacy controls", async () => {
    bridge.trustState.mockReturnValue({
      tone: "good",
      label: "Nothing leaves this Mac",
      title: "The AI runs on this Mac.",
    });
    const statusProps = props({ fileCount: 1 });
    const view = await renderStatus(statusProps);
    expect(view.host.textContent).toContain("Nothing leaves this Mac");
    expect(view.host.textContent).toContain("1 room file");
    expect(view.host.textContent).not.toContain("Offline");
    await click(button(view.host, "Nothing leaves this Mac"), view.window);
    expect(statusProps.onOpenPrivacy).toHaveBeenCalledOnce();
    expect(bridge.trustState).toHaveBeenCalledWith(false, true);
    await act(async () => view.root.unmount());
  });

  it("explains cloud and outbound routes and opens activity for pending work", async () => {
    const statusProps = props({
      cloud: true,
      engineLabel: "Cloud engine",
      webOn: true,
      mcpToolCount: 2,
      runningJobs: 2,
      pendingApprovals: 1,
    });
    const view = await renderStatus(statusProps);
    expect(view.host.textContent).toContain(
      "Protected cloud · online search on · 2 connected tools",
    );
    expect(view.host.textContent).toContain("1 approval waiting");
    expect(view.host.textContent).toContain("2 jobs running or waiting");
    await click(button(view.host, "approval waiting"), view.window);
    await click(button(view.host, "jobs running"), view.window);
    expect(statusProps.onShowActivity).toHaveBeenCalledTimes(2);
    await act(async () => view.root.unmount());
  });

  it("uses the local outbound warning and tracks online/offline listener events", async () => {
    const statusProps = props({ webOn: true, mcpToolCount: 1 });
    const view = await renderStatus(statusProps, false);
    expect(view.host.textContent).toContain(
      "Local model · online search on · 1 connected tool",
    );
    expect(view.host.textContent).toContain("Offline");
    await act(async () => {
      view.window.dispatchEvent(new view.window.Event("online"));
    });
    await flush();
    expect(view.host.textContent).not.toContain("Offline");
    await act(async () => {
      view.window.dispatchEvent(new view.window.Event("offline"));
    });
    await flush();
    expect(view.host.textContent).toContain("Offline");
    await act(async () => view.root.unmount());
  });

  it("defaults to online when the host cannot report a network state", async () => {
    const view = await renderStatus(props(), undefined);
    expect(view.host.textContent).not.toContain("Offline");
    await act(async () => view.root.unmount());
  });
});
