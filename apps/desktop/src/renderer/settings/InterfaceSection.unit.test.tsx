import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  resetAll: vi.fn(),
  setDensity: vi.fn(),
  setTexture: vi.fn(),
  useInterfaceSettings: vi.fn(),
}));

vi.mock("../shell/CustomizeSidebar", () => ({
  CustomizeSidebarBody: () => null,
}));
vi.mock("../shell/useLayout", () => ({
  PRESETS: {
    focus: { hint: "The workspace alone", label: "Focus" },
    research: { hint: "Every pane", label: "Research" },
    review: { hint: "No assistant", label: "Review" },
  },
}));
vi.mock("./useInterfaceSettings", () => ({ useInterfaceSettings: fakes.useInterfaceSettings }));

import InterfaceSection from "./InterfaceSection";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const roots: Array<{ unmount(): void }> = [];

async function render(onApplyPreset?: (name: "focus" | "research" | "review") => void): Promise<HTMLElement> {
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
  })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("Fabricated settings root missing.");
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(InterfaceSection, { onApplyPreset })));
  return host;
}

function click(node: Element): void {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("Fabricated React click handler missing.");
  (node as unknown as Record<string, { onClick(): void }>)[key].onClick();
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.useInterfaceSettings.mockReturnValue({
    density: "compact",
    resetAll: fakes.resetAll,
    setDensity: fakes.setDensity,
    setTexture: fakes.setTexture,
    texture: "off",
  });
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("InterfaceSection with fabricated interface preferences", () => {
  it("shows disabled presets with clear room guidance when no workspace action is available", async () => {
    const host = await render();
    const presets = [...host.querySelectorAll<HTMLButtonElement>("button.iface-preset")];

    expect(host.textContent).toContain("Available from the Layout menu in the toolbar once a room is open.");
    expect(presets.map((button) => button.disabled)).toEqual([true, true, true]);
    expect(presets.map((button) => button.textContent)).toEqual([
      "FocusThe workspace alone",
      "ResearchEvery pane",
      "ReviewNo assistant",
    ]);
    expect([...host.querySelectorAll('[aria-label="Density"] [role="radio"]')].map((radio) => radio.getAttribute("aria-checked")))
      .toEqual(["false", "true"]);
    expect([...host.querySelectorAll('[aria-label="Canvas texture"] [role="radio"]')].map((radio) => radio.getAttribute("aria-checked")))
      .toEqual(["false", "true"]);
  });

  it("delegates preset, density, texture, and reset interactions to fabricated settings actions", async () => {
    const onApplyPreset = vi.fn();
    const host = await render(onApplyPreset);
    const presets = [...host.querySelectorAll<HTMLButtonElement>("button.iface-preset")];
    const density = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Density"] [role="radio"]')];
    const texture = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Canvas texture"] [role="radio"]')];
    const reset = host.querySelector<HTMLButtonElement>("button.cz-reset");
    if (!presets[1] || !density[0] || !texture[0] || !reset) throw new Error("Fabricated interface controls missing.");

    expect(host.textContent).toContain("Apply one to this room now.");
    expect(presets.every((button) => !button.disabled)).toBe(true);
    click(presets[1]);
    click(density[0]);
    click(texture[0]);
    click(reset);

    expect(onApplyPreset).toHaveBeenCalledWith("research");
    expect(fakes.setDensity).toHaveBeenCalledWith("comfortable");
    expect(fakes.setTexture).toHaveBeenCalledWith("subtle");
    expect(fakes.resetAll).toHaveBeenCalledOnce();
  });
});
