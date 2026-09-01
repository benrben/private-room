import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

const theme = vi.hoisted(() => ({
  getThemeChoice: vi.fn(),
  setTheme: vi.fn(),
  systemTheme: vi.fn(),
}));

vi.mock("../theme", () => theme);

import AppearanceSection from "./AppearanceSection";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const roots: Array<{ unmount(): void }> = [];

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
  })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(AppearanceSection)));
  return host;
}

function click(node: Element): void {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React click handler missing");
  (node as unknown as Record<string, { onClick(): void }>)[key].onClick();
}

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("AppearanceSection", () => {
  it("renders the fabricated system preference and its current system theme", async () => {
    theme.getThemeChoice.mockReturnValue("system");
    theme.systemTheme.mockReturnValue("dark");

    const host = await render();
    const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

    expect(radios.map((radio) => radio.textContent)).toEqual(["Follow the Mac", "Light", "Dark"]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(radios[0]?.className).toContain("active");
    expect(host.textContent).toContain("Following macOS, which is currently dark.");
    expect(theme.getThemeChoice).toHaveBeenCalledTimes(1);
  });

  it("persists a selected fabricated theme and immediately shows it as active", async () => {
    theme.getThemeChoice.mockReturnValue("light");
    theme.systemTheme.mockReturnValue("dark");

    const host = await render();
    const radios = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const dark = radios[2];
    if (!dark) throw new Error("dark option missing");

    await act(async () => click(dark));

    expect(theme.setTheme).toHaveBeenCalledWith("dark");
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
    expect(dark.className).toContain("active");
    expect(host.textContent).toContain("A device preference");
  });
});
