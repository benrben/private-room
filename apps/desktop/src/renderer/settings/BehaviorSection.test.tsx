import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../icons", () => ({ CircleCheckIcon: () => null }));

import BehaviorSection from "./BehaviorSection";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

function props(overrides: Partial<React.ComponentProps<typeof BehaviorSection>> = {}) {
  return {
    adaptiveTextEnabled: true,
    autoIndex: false,
    changeAdaptiveTextEnabled: vi.fn(),
    changeAutoIndex: vi.fn(),
    changeEditApproval: vi.fn(),
    changeMemoryAutoSave: vi.fn(),
    changeResponseStyle: vi.fn(),
    editApproval: "turn",
    instructions: "Answer clearly.",
    memoryAutoSave: true,
    responseStyle: "terse",
    saved: false,
    saveTuning: vi.fn(),
    setInstructions: vi.fn(),
    setTemperature: vi.fn(),
    temperature: 0.4,
    ...overrides,
  };
}

async function render(input = props()) {
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
  if (!host) throw new Error("BehaviorSection test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(BehaviorSection, input));
    await Promise.resolve();
  });
  return { host, input, root };
}

function reactProps<T>(node: Element): T {
  const key = Object.getOwnPropertyNames(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing from test control");
  return (node as unknown as Record<string, unknown>)[key] as T;
}

async function close(view: Awaited<ReturnType<typeof render>>) {
  await act(async () => {
    view.root.unmount();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("BehaviorSection", () => {
  it("renders the room-scoped controls with their current fabricated values", async () => {
    const view = await render(props({ saved: true }));
    const radios = view.host.querySelectorAll<HTMLButtonElement>('button[role="radio"]');

    expect(view.host.textContent).toContain("These belong to this room. Another room keeps its own.");
    expect(view.host.querySelector('input[type="range"]')?.getAttribute("value")).toBe("0.4");
    const instructions = view.host.querySelector("textarea");
    if (!instructions) throw new Error("instructions textarea missing");
    expect(reactProps<{ value: string }>(instructions).value).toBe("Answer clearly.");
    expect([...radios].map((radio) => radio.textContent)).toEqual(["Default", "Terse", "Friendly", "Formal"]);
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[0]?.className).not.toContain("active");
    expect(view.host.querySelector("button.primary")?.textContent).toContain("Saved");
    await close(view);
  });

  it("forwards each fabricated setting choice to its owning callback", async () => {
    const view = await render();
    const range = view.host.querySelector('input[type="range"]');
    const textarea = view.host.querySelector("textarea");
    const radios = view.host.querySelectorAll<HTMLButtonElement>('button[role="radio"]');
    const toggles = view.host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const select = view.host.querySelector("select");
    const save = view.host.querySelector("button.primary");
    if (!range || !textarea || radios.length !== 4 || toggles.length !== 3 || !select || !save) {
      throw new Error("BehaviorSection controls missing");
    }

    await act(async () => {
      reactProps<{ onChange: (event: { target: { value: string } }) => void }>(range)
        .onChange({ target: { value: "0.65" } });
      reactProps<{ onChange: (event: { target: { value: string } }) => void }>(textarea)
        .onChange({ target: { value: "Use short paragraphs." } });
      for (const radio of radios) reactProps<{ onClick: () => void }>(radio).onClick();
      reactProps<{ onChange: (event: { target: { checked: boolean } }) => void }>(toggles[0]!)
        .onChange({ target: { checked: true } });
      reactProps<{ onChange: (event: { target: { checked: boolean } }) => void }>(toggles[1]!)
        .onChange({ target: { checked: false } });
      reactProps<{ onChange: (event: { target: { checked: boolean } }) => void }>(toggles[2]!)
        .onChange({ target: { checked: false } });
      reactProps<{ onChange: (event: { target: { value: string } }) => void }>(select)
        .onChange({ target: { value: "edit" } });
      reactProps<{ onClick: () => void }>(save).onClick();
    });

    expect(view.input.setTemperature).toHaveBeenCalledWith(0.65);
    expect(view.input.setInstructions).toHaveBeenCalledWith("Use short paragraphs.");
    expect(view.input.changeResponseStyle).toHaveBeenCalledWith("default");
    expect(view.input.changeResponseStyle).toHaveBeenCalledWith("terse");
    expect(view.input.changeResponseStyle).toHaveBeenCalledWith("friendly");
    expect(view.input.changeResponseStyle).toHaveBeenCalledWith("formal");
    expect(view.input.changeAutoIndex).toHaveBeenCalledWith(true);
    expect(view.input.changeMemoryAutoSave).toHaveBeenCalledWith(false);
    expect(view.input.changeAdaptiveTextEnabled).toHaveBeenCalledWith(false);
    expect(view.input.changeEditApproval).toHaveBeenCalledWith("edit");
    expect(view.input.saveTuning).toHaveBeenCalledOnce();
    await close(view);
  });

  it("stops only Escape from bubbling out of fabricated instructions edits", async () => {
    const view = await render();
    const textarea = view.host.querySelector("textarea");
    if (!textarea) throw new Error("instructions textarea missing");
    const onKeyDown = reactProps<{ onKeyDown: (event: { key: string; stopPropagation: () => void }) => void }>(textarea)
      .onKeyDown;
    const stopEscape = vi.fn();
    const stopEnter = vi.fn();

    onKeyDown({ key: "Escape", stopPropagation: stopEscape });
    onKeyDown({ key: "Enter", stopPropagation: stopEnter });

    expect(stopEscape).toHaveBeenCalledOnce();
    expect(stopEnter).not.toHaveBeenCalled();
    await close(view);
  });
});
