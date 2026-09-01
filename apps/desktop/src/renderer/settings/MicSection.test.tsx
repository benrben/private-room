import * as React from "react";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  configureMic: vi.fn(),
  getSetting: vi.fn(),
  micVoiceProcessing: vi.fn(),
  micVoiceProcessingFromSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("../api", () => ({ api: { getSetting: bridge.getSetting, setSetting: bridge.setSetting } }));
vi.mock("../icons", () => ({ CircleCheckIcon: () => null }));
vi.mock("../workspace/liveRec", () => ({
  configureMic: bridge.configureMic,
  micVoiceProcessing: bridge.micVoiceProcessing,
  micVoiceProcessingFromSetting: bridge.micVoiceProcessingFromSetting,
}));

import MicSection from "./MicSection";

const { act, createElement } = React;
const globalKeys = ["document", "window", "navigator", "HTMLElement", "Event", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originalGlobals = Object.fromEntries(globalKeys.map((key) => [key, Reflect.get(globalThis, key)]));

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
    root.render(createElement(MicSection));
    await Promise.resolve();
  });
  await flush();
  return { host, root };
}

function onChange(input: Element) {
  const key = Object.keys(input).find((candidate) => candidate.startsWith("__reactProps"));
  if (!key) throw new Error("React change handler missing");
  return (input as unknown as Record<string, { onChange: (event: { target: { checked: boolean } }) => void }>)[key].onChange;
}

async function setVoiceProcessing(view: Awaited<ReturnType<typeof render>>, checked: boolean) {
  const input = view.host.querySelector<HTMLInputElement>('[data-testid="mic-voice-processing"]');
  if (!input) throw new Error("microphone toggle missing");
  await act(async () => {
    onChange(input)({ target: { checked } });
    await Promise.resolve();
  });
  await flush();
}

async function close(view: Awaited<ReturnType<typeof render>>) {
  await act(async () => {
    view.root.unmount();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  bridge.configureMic.mockReset();
  bridge.getSetting.mockReset().mockResolvedValue(null);
  bridge.micVoiceProcessing.mockReset().mockReturnValue(false);
  bridge.micVoiceProcessingFromSetting.mockReset().mockImplementation((value) => value === "1");
  bridge.setSetting.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, key);
    else Reflect.set(globalThis, key, value);
  }
});

describe("MicSection", () => {
  it("applies the persisted voice-processing preference after loading it", async () => {
    bridge.getSetting.mockResolvedValueOnce("1");
    const view = await render();

    expect(bridge.getSetting).toHaveBeenCalledWith("mic_voice_processing");
    expect(bridge.micVoiceProcessingFromSetting).toHaveBeenCalledWith("1");
    expect(bridge.configureMic).toHaveBeenCalledWith(true);
    expect(view.host.textContent).toContain("On");
    await close(view);
  });

  it("applies, persists, and briefly confirms a user microphone choice", async () => {
    const view = await render();
    bridge.configureMic.mockClear();
    await setVoiceProcessing(view, true);

    expect(bridge.configureMic).toHaveBeenCalledWith(true);
    expect(bridge.setSetting).toHaveBeenCalledWith("mic_voice_processing", "1");
    expect(view.host.querySelector('[role="status"]')?.textContent).toContain("Saved");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(view.host.querySelector('[role="status"]')).toBeNull();
    await close(view);
  });

  it("keeps an immediately applied choice when persistence fails", async () => {
    bridge.setSetting.mockRejectedValueOnce(new Error("storage unavailable"));
    bridge.getSetting.mockResolvedValueOnce("1");
    const view = await render();
    bridge.configureMic.mockClear();
    await setVoiceProcessing(view, false);

    expect(bridge.configureMic).toHaveBeenCalledWith(false);
    expect(bridge.setSetting).toHaveBeenCalledWith("mic_voice_processing", "0");
    expect(view.host.textContent).toContain("Off");
    expect(view.host.querySelector('[role="status"]')).toBeNull();
    await close(view);
  });

  it("keeps the current preference when the stored preference cannot be read", async () => {
    bridge.micVoiceProcessing.mockReturnValueOnce(true);
    bridge.getSetting.mockRejectedValueOnce(new Error("read unavailable"));
    const view = await render();

    expect(view.host.textContent).toContain("On");
    expect(bridge.configureMic).not.toHaveBeenCalled();
    await close(view);
  });
});
