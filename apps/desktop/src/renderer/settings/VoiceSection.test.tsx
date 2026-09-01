import * as React from "react";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NeuralVoiceInfo } from "../api";
import VoiceSection from "./VoiceSection";

vi.mock("../icons", () => ({
  CircleCheckIcon: () => null,
  PlayIcon: () => null,
  StopIcon: () => null,
}));

const globalKeys = ["window", "document", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

const voices: NeuralVoiceInfo[] = [
  { id: "en-US-AndrewMultilingualNeural", gender: "Male", locale: "en-US" },
  { id: "he-IL-AvriNeural", gender: "Male", locale: "he-IL" },
];

function props(overrides: Record<string, unknown> = {}) {
  return {
    neuralVoiceId: "en-US-AndrewMultilingualNeural",
    setNeuralVoiceId: vi.fn(),
    archetype: "ghost",
    pickArchetype: vi.fn(),
    params: { reverb: 0.4, distortion: 0.2 },
    setParam: vi.fn(),
    voices,
    voicesError: false,
    save: vi.fn(),
    saved: false,
    saveError: "",
    preview: vi.fn(),
    previewing: false,
    ...overrides,
  } as React.ComponentProps<typeof VoiceSection>;
}

async function render(input = props()) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  const document = parsed.document as unknown as Document;
  const window = parsed.window as unknown as Window & typeof globalThis;
  Reflect.set(globalThis, "window", window);
  Reflect.set(globalThis, "document", document);
  Reflect.set(globalThis, "navigator", window.navigator);
  Reflect.set(globalThis, "HTMLElement", window.HTMLElement);
  Reflect.set(globalThis, "Event", window.Event);
  Reflect.set(globalThis, "React", React);
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const host = document.getElementById("root");
  if (!host) throw new Error("test root missing");
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(VoiceSection, input));
    await Promise.resolve();
  });
  return { host, input, close: async () => act(async () => root.unmount()) };
}

function reactHandler(element: Element, name: string) {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error("React props missing");
  return (element as unknown as Record<string, Record<string, (event?: unknown) => void>>)[key][name];
}

function button(host: Element, label: string) {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim().includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("VoiceSection", () => {
  it("groups the provided catalog and keeps an unavailable saved voice selectable", async () => {
    const catalog = await render();
    expect(catalog.host.textContent).toContain("Voice (2 available)");
    expect(catalog.host.querySelector('optgroup[label="Multilingual — reads any language"]')).not.toBeNull();
    expect(catalog.host.querySelector('optgroup[label="Hebrew (Israel)"]')).not.toBeNull();
    await catalog.close();

    const unavailable = await render(props({ neuralVoiceId: "fr-FR-SavedNeural", voices: [], voicesError: true }));
    expect(unavailable.host.textContent).toContain("Saved — saved voice");
    expect(unavailable.host.textContent).toContain("Couldn't load the voice catalog");
    await unavailable.close();
  });

  it("forwards picker, slider, archetype, preview, and save actions", async () => {
    const view = await render();
    const select = view.host.querySelector("select");
    const sliders = [...view.host.querySelectorAll('input[type="range"]')];
    if (!select || sliders.length !== 2) throw new Error("voice controls missing");
    reactHandler(select, "onChange")({ target: { value: "he-IL-AvriNeural" } });
    reactHandler(button(view.host, "Demon"), "onClick")();
    reactHandler(sliders[0], "onChange")({ target: { value: "0.65" } });
    reactHandler(sliders[1], "onChange")({ target: { value: "0.35" } });
    reactHandler(button(view.host, "Preview"), "onClick")();
    reactHandler(button(view.host, "Save"), "onClick")();
    expect(view.input.setNeuralVoiceId).toHaveBeenCalledWith("he-IL-AvriNeural");
    expect(view.input.pickArchetype).toHaveBeenCalledWith("demon");
    expect(view.input.setParam).toHaveBeenNthCalledWith(1, "reverb", 0.65);
    expect(view.input.setParam).toHaveBeenNthCalledWith(2, "distortion", 0.35);
    expect(view.input.preview).toHaveBeenCalledOnce();
    expect(view.input.save).toHaveBeenCalledOnce();
    await view.close();
  });

  it("shows the active preview, saved, and save-error states", async () => {
    const view = await render(props({ previewing: true, saved: true, saveError: "Couldn't save voice" }));
    expect(view.host.textContent).toContain("Stop preview");
    expect(view.host.textContent).toContain("Saved");
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("Couldn't save voice");
    await view.close();
  });
});
