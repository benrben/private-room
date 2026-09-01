import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  areaDef: vi.fn(),
  nav: null as Record<string, unknown> | null,
  reset: vi.fn(),
  togglePin: vi.fn(),
  move: vi.fn(),
  useNavPrefs: vi.fn(),
}));

vi.mock("./navPrefs", () => ({ areaDef: fakes.areaDef, useNavPrefs: fakes.useNavPrefs }));
vi.mock("../settings/useFocusTrap", () => ({
  useFocusTrap: () => ({ modalRef: { current: null }, onModalKeyDown: vi.fn() }),
}));
vi.mock("../icons", () => ({ ChevronDownIcon: () => null, ChevronUpIcon: () => null, CloseIcon: () => null }));

import { CustomizeSidebarBody } from "./CustomizeSidebar";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "HTMLButtonElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));
const roots: Array<{ unmount(): void }> = [];

function nav(pinned: string[], more: string[]) {
  return { pinned, more, move: fakes.move, togglePin: fakes.togglePin, reset: fakes.reset };
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
    HTMLButtonElement: window.HTMLButtonElement,
    Event: window.Event,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) Reflect.set(globalThis, key, value);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(createElement(CustomizeSidebarBody)));
  return host;
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function click(button: Element) {
  await act(async () => reactProps<{ onClick(): void }>(button).onClick());
}

beforeEach(() => {
  fakes.areaDef.mockReset().mockImplementation((key: string) => ({
    label: `Fake ${key}`,
    blurb: `Fabricated ${key} destination.`,
    icon: () => null,
  }));
  fakes.move.mockReset();
  fakes.togglePin.mockReset();
  fakes.reset.mockReset();
  fakes.nav = nav(["alpha", "beta"], ["gamma"]);
  fakes.useNavPrefs.mockReset().mockImplementation(() => fakes.nav);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("CustomizeSidebarBody", () => {
  it("renders fabricated groups and forwards every visible move, pin, and reset action", async () => {
    const host = await render();
    const button = (label: string) => {
      const found = [...host.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === label);
      if (!found) throw new Error(`button not found: ${label}`);
      return found;
    };

    expect([...host.querySelectorAll(".cz-group-label")].map((label) => label.textContent)).toEqual([
      "Pinned",
      "Under More tools",
    ]);
    expect(button("Move Fake alpha up").hasAttribute("disabled")).toBe(true);
    expect(button("Move Fake alpha down").hasAttribute("disabled")).toBe(false);
    expect(button("Move Fake beta down").hasAttribute("disabled")).toBe(true);
    expect(button("Move Fake gamma up").hasAttribute("disabled")).toBe(true);
    expect([...host.querySelectorAll('[role="switch"]')].map((item) => item.getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
      "false",
    ]);

    await click(button("Move Fake alpha down"));
    await click(button("Move Fake beta up"));
    await click(button("Pin Fake gamma to the sidebar"));
    const reset = host.querySelector(".cz-reset");
    if (!reset) throw new Error("reset button missing");
    await click(reset);
    expect(fakes.move.mock.calls).toEqual([["alpha", 1], ["beta", -1]]);
    expect(fakes.togglePin).toHaveBeenCalledWith("gamma");
    expect(fakes.reset).toHaveBeenCalledOnce();
  });

  it("explains both fabricated empty groups", async () => {
    fakes.nav = nav([], []);
    const host = await render();

    expect(host.querySelectorAll(".cz-row")).toHaveLength(0);
    expect(host.textContent).toContain("Nothing pinned — every tool is under More tools.");
    expect(host.textContent).toContain("Everything is pinned.");
  });
});
