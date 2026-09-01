import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  voicesList: vi.fn(),
  voiceForget: vi.fn(),
  formatWhen: vi.fn(),
}));

vi.mock("../api", () => ({
  api: {
    voicesList: bridge.voicesList,
    voiceForget: bridge.voiceForget,
  },
}));
vi.mock("../workspace/composer", () => ({ formatWhen: bridge.formatWhen }));

import SavedVoicesSection from "./SavedVoicesSection";

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
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function voice(overrides: Record<string, unknown> = {}) {
  return {
    name: "Dana",
    seconds: 1.5,
    takes: 1,
    corrections: 1,
    updatedAt: "2026-08-30T12:00:00.000Z",
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render() {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  for (const [key, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Reflect.set(globalThis, key, value);
  }
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => root.render(createElement(SavedVoicesSection)));
  await flush();
  return { host, root, window };
}

function button(host: Element, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found as HTMLButtonElement;
}

async function click(node: Element, window: Window & typeof globalThis) {
  await act(async () => node.dispatchEvent(new window.Event("click", { bubbles: true })));
  await flush();
}

beforeEach(() => {
  bridge.voicesList.mockReset();
  bridge.voiceForget.mockReset();
  bridge.formatWhen.mockReset();
  bridge.formatWhen.mockImplementation((updatedAt: string) => `when ${updatedAt}`);
});

afterEach(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("SavedVoicesSection", () => {
  it("shows the empty-state explanation after the fabricated voice list loads", async () => {
    bridge.voicesList.mockResolvedValue([]);
    const view = await render();
    expect(bridge.voicesList).toHaveBeenCalledOnce();
    expect(view.host.textContent).toContain("Nobody yet. Name a speaker");
    expect(view.host.querySelector('[data-testid="saved-voices"]')).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("shows a load failure instead of the empty-state claim", async () => {
    bridge.voicesList.mockRejectedValue(new Error("saved voices are unavailable"));
    const view = await render();
    expect(view.host.querySelector(".gate-error")?.textContent).toContain("saved voices are unavailable");
    expect(view.host.textContent).not.toContain("Nobody yet");
    await act(async () => view.root.unmount());
  });

  it("renders voice evidence and confirms, cancels, then completes a forget action", async () => {
    const dana = voice();
    const riley = voice({ name: "Riley", seconds: 8.2, takes: 2, corrections: 2 });
    bridge.voicesList.mockResolvedValue([dana, riley]);
    bridge.voiceForget.mockResolvedValue([riley]);
    const view = await render();

    const danaRow = view.host.querySelector('[data-voice="Dana"]');
    const rileyRow = view.host.querySelector('[data-voice="Riley"]');
    expect(danaRow?.textContent).toContain("2s of speech from 1 recording");
    expect(danaRow?.textContent).toContain("1 correction");
    expect(rileyRow?.textContent).toContain("8s of speech from 2 recordings");
    expect(rileyRow?.textContent).toContain("2 corrections");
    expect(view.host.textContent).toContain("when 2026-08-30T12:00:00.000Z");

    await click(button(danaRow!, "Forget"), view.window);
    const confirmation = view.host.querySelector(".ckpt-confirm");
    expect(confirmation?.textContent).toContain("Forget Dana's voice?");
    expect(confirmation?.hasAttribute("data-agent-blocked")).toBe(true);
    await click(button(confirmation!, "Cancel"), view.window);
    expect(view.host.querySelector(".ckpt-confirm")).toBeNull();

    await click(button(view.host.querySelector('[data-voice="Dana"]')!, "Forget"), view.window);
    await click(button(view.host.querySelector(".ckpt-confirm")!, "Forget"), view.window);
    expect(bridge.voiceForget).toHaveBeenCalledWith("Dana");
    expect(view.host.querySelector('[data-voice="Dana"]')).toBeNull();
    expect(view.host.querySelector('[data-voice="Riley"]')).not.toBeNull();
    expect(view.host.querySelector(".gate-error")).toBeNull();
    await act(async () => view.root.unmount());
  });

  it("surfaces a fabricated forget failure and leaves the row available", async () => {
    bridge.voicesList.mockResolvedValue([voice()]);
    bridge.voiceForget.mockRejectedValue(new Error("forget failed"));
    const view = await render();
    await click(button(view.host.querySelector('[data-voice="Dana"]')!, "Forget"), view.window);
    await click(button(view.host.querySelector(".ckpt-confirm")!, "Forget"), view.window);
    expect(bridge.voiceForget).toHaveBeenCalledWith("Dana");
    expect(view.host.querySelector(".gate-error")?.textContent).toContain("forget failed");
    expect(view.host.querySelector(".ckpt-confirm")).toBeNull();
    expect(view.host.querySelector('[data-voice="Dana"]')).not.toBeNull();
    await act(async () => view.root.unmount());
  });
});
